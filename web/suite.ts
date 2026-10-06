import type { MiniAppClient, MiniAppOperation } from "@lo-ink/miniapp-sdk";
import { cases, events, operationNames } from "./cases.ts";
import { bounded, pause, type Check, type CheckOutcome } from "./runner.ts";
import type { WriteAccessResult } from "./consent.ts";
import type { Interact } from "./interaction.ts";
import type { AudioStart } from "./audio.ts";
import { deferredOperations, guidedBridgeCheck } from "./bridge-checks.ts";
export type SuiteContext = {
  client: MiniAppClient | null;
  api: <T>(path: string, body: unknown, signal: AbortSignal) => Promise<T>;
  consent: boolean | null;
  includeBot: boolean;
  writeAccess?: Promise<WriteAccessResult>;
  consentChanged?: (allowed: boolean) => void;
  verified: () => void;
  observed: () => Record<string, string>;
  audioState?: () => string;
  audioStarted?: Promise<AudioStart>;
  interact?: Interact;
  playAudio?: () => Promise<void>;
  supportsOperation?: (name: MiniAppOperation, input: unknown) => boolean;
  appearanceGuard?: (testing: boolean, operation?: MiniAppOperation) => void;
  panelExpanded?: () => boolean | undefined;
};
export function createSuite(context: SuiteContext) {
  const { client } = context;
  const plan: Check[] = [];
  const key = `lo-sdk-run-${crypto.randomUUID()}`;
  const value = "SDK Test roundtrip";
  let signed = false;
  let consent = context.consent;
  let botReady = false;
  const written = new Set<string>();
  const removed = new Set<string>();
  const passed = new Set<string>();
  const mutations = new Map<MiniAppOperation, number>();
  const original = client?.adapter.snapshot?.();
  let lastBot = 0;
  let lastCloud = 0;
  const call = async (
    name: MiniAppOperation,
    input: unknown,
    signal: AbortSignal,
  ) => {
    const cloud = name.startsWith("cloudStorage");
    // LO's Mini App listener refills one request per second. Keep every
    // roundtrip step, including enumeration and cleanup, within that budget.
    if (cloud && lastCloud)
      await pause(Math.max(0, 1100 - (Date.now() - lastCloud)), signal);
    try {
      return await client!.call(name, input as never, { signal });
    } catch (error) {
      if (cloud)
        throw new Error(
          `${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      throw error;
    } finally {
      if (cloud) lastCloud = Date.now();
    }
  };
  const assert = (ok: unknown, message: string) => {
    if (!ok) throw new Error(message);
  };
  plan.push(
    {
      id: "server",
      label: "Доступность сервера и настройки приложения",
      group: "Запуск",
      execute: async (signal) => {
        const status = await context.api<{
          appConfigured: boolean;
          botConfigured: boolean;
        }>("status", undefined, signal);
        assert(status.appConfigured, "На сервере не настроен ключ приложения");
        botReady = status.botConfigured;
        return `Сервер доступен; приложение настроено; бот ${botReady ? "настроен" : "не настроен"}`;
      },
    },
    {
      id: "signature",
      label: "Подпись данных запуска",
      group: "Запуск",
      skip: () =>
        !client?.adapter.launchData
          ? {
              state: "skipped",
              detail:
                "Откройте приложение внутри LO: в браузере нет подписанных данных запуска",
            }
          : undefined,
      execute: async (signal) => {
        const result = await context.api<{
          verified: boolean;
          verifiers?: string[];
        }>("session", { raw: client!.adapter.launchData }, signal);
        assert(result.verified === true, "Сервер не подтвердил подпись");
        signed = true;
        context.verified();
        if (consent !== null)
          await context.api("consent", { allowed: consent }, signal);
        return result.verifiers?.length
          ? `Подпись проверена: ${result.verifiers.join(" + ")}`
          : "Подпись проверена сервером";
      },
    },
    {
      id: "safe-area",
      label: "Безопасные поля экрана",
      group: "Запуск",
      skip: () =>
        !client
          ? { state: "skipped", detail: "Нет подключения к LO" }
          : undefined,
      execute: async () => {
        const style = getComputedStyle(document.documentElement);
        const values = ["top", "right", "bottom", "left"].map(
          (side) =>
            [
              side,
              parseFloat(style.getPropertyValue(`--lo-safe-${side}`)),
            ] as const,
        );
        assert(
          values.every(([, v]) => Number.isFinite(v) && v >= 0),
          "Приложение LO не передало корректные поля экрана",
        );
        return (
          values.map(([side, v]) => `${side}: ${v}px`).join(" · ") +
          "; отсутствие обрезки проверяется визуально"
        );
      },
    },
  );
  plan.push({
    id: "requestWriteAccess",
    label: "Разрешение на сообщения бота",
    group: "Приложение LO",
    evidence: "data",
    timeoutMs: 60000,
    skip: () => {
      if (!context.includeBot)
        return {
          state: "manual",
          detail: "Отправка сообщений отключена перед запуском",
        };
      if (!botReady)
        return { state: "skipped", detail: "Бот не настроен на сервере" };
      if (!client?.supports("requestWriteAccess"))
        return {
          state: "skipped",
          detail: "Приложение LO не поддерживает запрос разрешения",
        };
      if (!signed)
        return { state: "skipped", detail: "Подпись запуска не подтверждена" };
      if (!context.writeAccess)
        return {
          state: "manual",
          detail:
            "Нажмите «Запустить все проверки», чтобы запросить разрешение в LO",
        };
      return undefined;
    },
    execute: async (signal) => {
      assert(context.writeAccess, "Запрос разрешения через мост не выполнен");
      const result = await context.writeAccess!;
      signal.throwIfAborted();
      if (result.error) throw new Error(result.error);
      context.consentChanged?.(result.allowed);
      await context.api("consent", { allowed: result.allowed }, signal);
      consent = result.allowed;
      assert(
        result.allowed,
        "Отправка сообщений не разрешена; проверки бота с отправкой будут пропущены",
      );
      return "Запрос выполнен через мост; LO подтвердил разрешение";
    },
  });
  plan.push({
    id: "audio-context",
    label: "Звуковой контекст после нажатия",
    group: "Запуск",
    execute: async () => {
      const start = context.audioStarted
        ? await context.audioStarted
        : { state: context.audioState?.() };
      assert(
        start.state === "running",
        "Звуковой контекст не запущен. Повторите тест звука в разделе «Вручную → Данные запуска»",
      );
      return "AudioContext running непосредственно после нажатия; последующая приостановка LO не меняет этот результат";
    },
  });
  if (context.interact && context.playAudio)
    plan.push({
      id: "audio-playback",
      label: "Слышимость звука",
      group: "Запуск",
      timeoutMs: 180000,
      timeoutState: "manual",
      execute: async (signal) => {
        const result = await context.interact!(
          {
            title: "Звук",
            detail: "Будет короткий сигнал. Проверьте громкость устройства.",
            action: context.playAudio!,
            actionLabel: "Воспроизвести",
            question: "Услышали сигнал?",
          },
          signal,
        );
        if (result.decision === "skip")
          return { state: "manual", detail: "Слышимость звука не проверена" };
        assert(
          result.decision === "yes",
          "Звуковой контекст запущен, но сигнал не слышен",
        );
        return {
          state: "passed",
          evidence: "device",
          detail: "Сигнал воспроизведён и подтверждён пользователем",
        };
      },
    });
  const hostNames = [
    ...operationNames.filter(
      (name) => name !== "requestWriteAccess" && !/Storage/.test(name),
    ),
    ...operationNames.filter((name) => /Storage/.test(name)),
  ];
  for (const name of hostNames) {
    const definition = cases[name];
    const storage = /^(cloud|device|secure)Storage/.exec(name)?.[0];
    const autoStorage = storage && !/Clear|Restore/.test(name);
    const dependency =
      storage && /Get|Keys|Remove/.test(name) ? `${storage}Set` : null;
    let finalizer: ((signal: AbortSignal) => Promise<void>) | undefined;
    plan.push({
      id: name,
      finalize: async (signal) => {
        const restore = finalizer;
        finalizer = undefined;
        if (restore) await restore(signal);
      },
      label: definition.label,
      group: "Приложение LO",
      skip: () => {
        if (!client)
          return {
            state: "skipped",
            detail: "Откройте приложение в LO для живой проверки",
          };
        if (
          !client.supports(definition.capability) ||
          context.supportsOperation?.(name, definition.input) === false
        )
          return {
            state: "skipped",
            detail: `Приложение LO не поддерживает ${definition.capability}`,
          };
        if (deferredOperations.has(name))
          return {
            state: "manual",
            detail:
              "Закрывает мини-приложение. Проверяется кнопкой в отчёте после остальных шагов; результат сохраняется до повторного открытия.",
          };
        if (!context.interact && !autoStorage)
          return {
            state: "manual",
            detail:
              "Требуется отдельное действие. Метод доступен в разделе «Вручную → Приложение LO»",
          };
        if (dependency && !passed.has(dependency))
          return {
            state: "skipped",
            detail:
              "Запись тестового ключа не удалась; чтение и удаление не проверяются как успешные",
          };
        if (
          /^stop(Accelerometer|Gyroscope|DeviceOrientation)$/.test(name) &&
          !passed.has(name.replace("stop", "start"))
        )
          return {
            state: "manual",
            detail:
              "Старт датчика не подтверждён; остановка активного датчика не проверена",
          };
        return undefined;
      },
      timeoutMs: context.interact && !autoStorage ? 180000 : undefined,
      timeoutState: context.interact && !autoStorage ? "manual" : undefined,
      evidence: "data",
      execute: async (signal) => {
        if (!autoStorage && context.interact) {
          const result = await guidedBridgeCheck(
            name,
            {
              client: client!,
              interact: context.interact,
              observed: context.observed,
              appearanceGuard: context.appearanceGuard,
              panelExpanded: context.panelExpanded,
              deferCleanup: (restore) => {
                finalizer = restore;
              },
              mutated: (operation) =>
                mutations.set(operation, (mutations.get(operation) ?? 0) + 1),
              mutationRejected: (operation) => {
                const remaining = (mutations.get(operation) ?? 0) - 1;
                if (remaining > 0) mutations.set(operation, remaining);
                else mutations.delete(operation);
              },
            },
            signal,
            storage && /Restore$/.test(name) ? { key } : undefined,
          );
          if (result.state === "passed") passed.add(name);
          return result;
        }
        let input: unknown = definition.input;
        if (storage) {
          if (/Set$/.test(name)) {
            written.add(storage);
            input = { key, value };
          } else if (/GetMany$|RemoveMany$/.test(name)) input = { keys: [key] };
          else if (!/Keys$/.test(name)) input = { key };
          // RemoveMany gets a fresh key after Remove so both mutations are meaningful.
          if (/RemoveMany$/.test(name) && removed.has(storage)) {
            assert(
              (await call(
                `${storage}Set` as MiniAppOperation,
                { key, value },
                signal,
              )) !== false,
              "Не удалось повторно записать ключ для массового удаления",
            );
            removed.delete(storage);
          }
        }
        // Enumeration must verify both a populated and an empty owned-key result.
        // Reinsert BEFORE the first Keys call; preserve unrelated keys throughout.
        if (storage && /Keys$/.test(name)) {
          assert(
            (await call(
              `${storage}Set` as MiniAppOperation,
              { key, value },
              signal,
            )) !== false,
            "Не удалось записать ключ для проверки списка",
          );
          removed.delete(storage);
        }
        const result = await call(name, input, signal);
        assert(result !== false, "Приложение LO отклонило действие");
        if (storage) {
          if (/Set$/.test(name)) {
            const stored = await call(
              `${storage}Get` as MiniAppOperation,
              { key },
              signal,
            );
            assert(
              (storage === "secureStorage"
                ? (stored as { value?: unknown })?.value
                : stored) === value,
              "Запись не подтверждена чтением тестового значения",
            );
          }
          if (/Get$/.test(name))
            assert(
              (storage === "secureStorage"
                ? (result as { value?: unknown })?.value
                : result) === value,
              "Прочитанное значение не совпадает с записанным",
            );
          if (/GetMany$/.test(name))
            assert(
              (result as Record<string, unknown>)?.[key] === value,
              "Массовое чтение не вернуло записанный ключ",
            );
          if (/Keys$/.test(name)) {
            assert(
              Array.isArray(result) && result.includes(key),
              "Список ключей не содержит тестовый ключ",
            );
            assert(
              (await call(
                `${storage}Remove` as MiniAppOperation,
                { key },
                signal,
              )) !== false,
              "Удаление ключа списка отклонено",
            );
            const after = await call(name, input, signal);
            assert(
              Array.isArray(after) && !after.includes(key),
              "После удаления список всё ещё содержит тестовый ключ",
            );
            removed.add(storage);
          }
          if (/Remove(Many)?$/.test(name)) {
            const empty = await call(
              `${storage}Get` as MiniAppOperation,
              { key },
              signal,
            );
            assert(
              storage === "secureStorage"
                ? (empty as { value?: unknown })?.value == null
                : empty == null || empty === "",
              "После удаления ключ всё ещё доступен",
            );
            removed.add(storage);
          }
          passed.add(name);
          return /Get|Keys/.test(name)
            ? "Значение проверено; содержимое остальных ключей не сохраняется"
            : "Операция с тестовым ключом подтверждена";
        }
        return "Приложение LO подтвердило действие; внешний вид и звук проверяются вручную";
      },
    });
  }
  for (const button of ["back", "secondary", "settings"] as const)
    plan.push({
      id: `button:${button}`,
      label: `Кнопка ${button}`,
      group: "Приложение LO",
      timeoutMs: 180000,
      timeoutState: "manual",
      skip: () =>
        !client?.supports(`${button}Button`)
          ? {
              state: "skipped",
              detail: `Мост не поддерживает кнопку ${button}`,
            }
          : !context.interact
            ? { state: "manual", detail: "Нажатие кнопки не проверено" }
            : undefined,
      execute: (signal) =>
        guidedBridgeCheck(
          "setButton",
          {
            client: client!,
            interact: context.interact!,
            observed: context.observed,
          },
          signal,
          {
            button,
            params:
              button === "secondary"
                ? { text: "SDK Test", visible: true, active: true }
                : { visible: true },
          },
        ),
    });
  let conformance:
    | Promise<{
        mode: string;
        networkCalls: number;
        results: { test: string; passed: boolean }[];
      }>
    | undefined;
  for (let index = 0; index < 14; index++)
    plan.push({
      id: `errors:${index}`,
      label: [
        "Ошибка 400",
        "Отказ 403",
        "Лимит 429 и пауза",
        "Недоступность 503",
        "URL вместо фото",
        "HTTP-кнопка",
        "Слишком длинная подпись",
        "ID за пределами int64",
        "Метаданные сохранённого видео",
        "Смешанный альбом",
        "Обход пути скачивания",
        "Недоступная загрузка аудио",
        "MIME голосового Blob",
        "Отмена некорректного потока",
      ][index],
      group: "Ошибки SDK · синтетические",
      evidence: "synthetic",
      execute: async (signal) => {
        conformance ??= context.api(
          "bot",
          { operation: "conformance" },
          signal,
        );
        const result = await conformance;
        assert(
          result.mode === "synthetic" &&
            result.networkCalls === 0 &&
            result.results[index]?.passed === true,
          "Синтетическая проверка обработки ошибки не прошла",
        );
        return `${result.results[index].test}: ожидаемое отклонение; реальных запросов к LO нет`;
      },
    });
  const botOperations = [
    "getIdentity",
    "getCapabilities",
    "getCommands",
    "setCommands",
    "setChatMenuButton",
    "sendMessage",
    "editMessage",
    "deleteMessage",
    "sendPhoto",
    "reusePhoto",
    "sendDocument",
    "reuseDocument",
    "sendVoice",
    "reuseVoice",
    "sendVideo",
    "reuseVideo",
    "photoAlbum",
    "documentAlbum",
    "getFile",
    "downloadFile",
    "getUpdates",
  ];
  for (const operation of botOperations)
    plan.push({
      id: `bot:${operation}`,
      label: (
        {
          getIdentity: "Данные бота",
          getCapabilities: "Возможности установки",
          sendVideo: "Отправка видео",
          reuseVideo: "Повторная отправка видео",
          photoAlbum: "Альбом фотографий",
          documentAlbum: "Альбом документов",
          getFile: "Метаданные файла",
          downloadFile: "Скачивание файла",
          getCommands: "Команды бота",
          setCommands: "Изменение команд",
          setChatMenuButton: "Кнопка меню чата",
          sendMessage: "Отправка сообщения",
          editMessage: "Изменение сообщения",
          deleteMessage: "Удаление сообщения",
          sendPhoto: "Отправка фото",
          reusePhoto: "Повторная отправка фото",
          sendDocument: "Отправка документа",
          reuseDocument: "Повторная отправка документа",
          sendVoice: "Отправка голосового сообщения",
          reuseVoice: "Повторная отправка голосового сообщения",
          getUpdates: "Получение обновлений",
        } as Record<string, string>
      )[operation],
      group: "Бот · живые проверки",
      skip: () => {
        if (!signed || !botReady)
          return {
            state: "skipped",
            detail: "Требуются проверенная подпись запуска и настройки бота",
          };
        if (
          ["setCommands", "getUpdates"].includes(operation) &&
          !context.interact
        )
          return {
            state: "manual",
            detail:
              operation === "getUpdates"
                ? "Получение обновлений влияет на другие обработчики; запускается отдельно в разделе «Вручную → Бот»"
                : "Команды меняются для всего бота; запускаются отдельно в разделе «Вручную → Бот»",
          };
        if (
          ![
            "getIdentity",
            "getCapabilities",
            "getCommands",
            "getFile",
            "downloadFile",
          ].includes(operation) &&
          (!context.includeBot || consent !== true)
        )
          return {
            state: "skipped",
            detail:
              "Отправка отключена или разрешение не получено. Включите сообщения на экране проверки и повторите запуск",
          };
        const dependency =
          operation === "editMessage" || operation === "deleteMessage"
            ? "sendMessage"
            : operation.startsWith("reuse")
              ? operation.replace("reuse", "send")
              : operation === "photoAlbum"
                ? "sendPhoto"
                : ["documentAlbum", "getFile"].includes(operation)
                  ? "sendDocument"
                  : operation === "downloadFile"
                    ? "getFile"
                    : null;
        if (dependency && !passed.has(`bot:${dependency}`))
          return {
            state: "skipped",
            detail: `Сначала должна успешно пройти ${dependency}`,
          };
        return undefined;
      },
      timeoutMs: ["setCommands", "getUpdates"].includes(operation)
        ? 180000
        : operation === "sendVideo"
          ? 95000
          : undefined,
      timeoutState: ["setCommands", "getUpdates"].includes(operation)
        ? "manual"
        : undefined,
      evidence: "response",
      execute: async (signal) => {
        let file: { data: string; name: string; mime: string } | undefined;
        if (
          ["sendPhoto", "sendDocument", "sendVoice", "sendVideo"].includes(
            operation,
          )
        ) {
          const source =
            operation === "sendPhoto"
              ? "/icon.png"
              : operation === "sendVoice"
                ? "/sdk-test.m4a"
                : operation === "sendVideo"
                  ? "/sdk-test.mp4"
                  : "/fixtures/test.txt";
          const response = await fetch(source, { signal });
          assert(response.ok, "Тестовый файл не загрузился");
          const bytes = new Uint8Array(await response.arrayBuffer());
          assert(
            bytes.length > 0 && bytes.length < 1000000,
            "Некорректный размер тестового файла",
          );
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          file = {
            data: btoa(binary),
            name: source.split("/").pop()!,
            mime:
              operation === "sendPhoto"
                ? "image/png"
                : operation === "sendVoice"
                  ? "audio/mp4"
                  : operation === "sendVideo"
                    ? "video/mp4"
                    : "text/plain",
          };
        }
        const request = async () => {
          if (lastBot)
            await pause(Math.max(0, 2300 - (Date.now() - lastBot)), signal);
          try {
            return await context.api<{ mode: string; result: unknown }>(
              "bot",
              { operation, ...(file ? { file } : {}) },
              signal,
            );
          } finally {
            lastBot = Date.now();
          }
        };
        let result;
        if (
          ["setCommands", "getUpdates"].includes(operation) &&
          context.interact
        ) {
          const answer = await context.interact(
            {
              title:
                operation === "setCommands"
                  ? "Команда тестового бота"
                  : "Обновления тестового бота",
              detail:
                operation === "setCommands"
                  ? "У тестового бота появится команда /test. Это меняет меню этого бота."
                  : "Будет один запрос без ожидания и без продвижения общего offset; в отчёт чужие сообщения не попадут.",
              action: request,
            },
            signal,
          );
          if (answer.decision === "skip")
            return { state: "manual", detail: "Проверка бота пропущена" };
          result = answer.value as { mode: string; result: unknown };
        } else {
          try {
            result = await request();
          } catch (error) {
            const reason = (error as { reason?: string }).reason;
            if (
              reason === "feature_disabled" ||
              reason === "method_not_implemented"
            )
              return {
                state: "skipped",
                detail: `Установка LO отклонила возможность: ${reason}. Работоспособность не подтверждена.`,
              };
            throw error;
          }
        }
        assert(
          result.mode === "live" && result.result !== false,
          "Бот не подтвердил живую операцию",
        );
        if (
          operation === "getCapabilities" &&
          !(result.result as { known: boolean }).known
        )
          return {
            state: "skipped",
            detail:
              "Текущий сервер не возвращает флаги установки; доступность возможностей не подтверждена",
          };
        if (operation === "downloadFile")
          assert(
            (result.result as { bytes: number; verifiedContent: boolean })
              .bytes > 0 &&
              (result.result as { verifiedContent: boolean })
                .verifiedContent === true,
            "Скачан пустой файл",
          );
        if (["photoAlbum", "documentAlbum"].includes(operation))
          assert(
            Array.isArray(result.result) && result.result.length === 2,
            "API не вернул две части альбома",
          );
        passed.add(`bot:${operation}`);
        return "Живой API LO подтвердил операцию; доставка на устройство оценивается вручную";
      },
    });
  for (const event of events)
    plan.push({
      id: `event:${event}`,
      label: event,
      group: "События",
      evidence: "data",
      skip: () =>
        !context.observed()[event]
          ? {
              state: "manual",
              detail:
                "В этом прогоне событие не получено. Для проверки выполните соответствующее действие в LO",
            }
          : undefined,
      execute: async () =>
        `Получено во время этого прогона: ${context.observed()[event]}`,
    });
  const cleanup: Check = {
    id: "cleanup",
    label: "Очистка ключей текущего прогона",
    group: "Завершение",
    skip: () =>
      !written.size && !mutations.size
        ? {
            state: "skipped",
            detail: "Тестовые ключи не создавались; очистка не требуется",
          }
        : undefined,
    execute: async (signal) => {
      const errors: string[] = [];
      for (const storage of written) {
        try {
          const removed = await bounded(
            (s) => call(`${storage}Remove` as MiniAppOperation, { key }, s),
            signal,
            3000,
          );
          assert(removed !== false, "Удаление отклонено");
        } catch {
          errors.push(storage);
        }
      }
      const restore = async (name: MiniAppOperation, input: unknown) => {
        try {
          const restored = await bounded(
            (s) => client!.call(name, input as never, { signal: s }),
            signal,
            3000,
          );
          assert(restored !== false, "Восстановление отклонено LO");
        } catch {
          errors.push(name);
        }
      };
      for (const [start, stop] of [
        ["startAccelerometer", "stopAccelerometer"],
        ["startGyroscope", "stopGyroscope"],
        ["startDeviceOrientation", "stopDeviceOrientation"],
      ] as const)
        if (mutations.has(start)) await restore(stop, undefined);
      if (mutations.has("setOrientationLock"))
        await restore("setOrientationLock", {
          locked: original?.isOrientationLocked ?? false,
        });
      if (mutations.has("setClosingConfirmation"))
        await restore("setClosingConfirmation", { enabled: false });
      if (mutations.has("setVerticalSwipes"))
        await restore("setVerticalSwipes", { enabled: true });
      if (mutations.has("updateBiometryToken"))
        await restore("updateBiometryToken", { token: "" });
      if (mutations.has("openQrScanner"))
        await restore("closeQrScanner", undefined);
      if (mutations.has("requestFullscreen") && !original?.isFullscreen)
        await restore("exitFullscreen", undefined);
      context.appearanceGuard?.(false);
      assert(
        !errors.length,
        `Не удалось очистить ${errors.join(", ")}. Ключ: ${key}; удалите его вручную`,
      );
      return "Тестовые ключи удалены, датчики остановлены и настройки экрана восстановлены";
    },
  };
  return { plan, cleanup };
}
