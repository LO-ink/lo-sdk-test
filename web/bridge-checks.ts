import type {
  MiniAppClient,
  MiniAppEvent,
  MiniAppOperation,
} from "@lo-ink/miniapp-sdk";
import { cases } from "./cases.ts";
import { bounded, pause, type CheckOutcome } from "./runner.ts";
import type { Interact, Interaction } from "./interaction.ts";

type Context = {
  client: MiniAppClient;
  interact: Interact;
  observed: () => Record<string, string>;
  appearanceGuard?: (testing: boolean, operation?: MiniAppOperation) => void;
  mutated?: (operation: MiniAppOperation, input: unknown) => void;
  mutationRejected?: (operation: MiniAppOperation) => void;
  panelExpanded?: () => boolean | undefined;
  deferCleanup?: (restore: (signal: AbortSignal) => Promise<void>) => void;
};
export const deferredOperations = new Set<MiniAppOperation>([
  "close",
  "sendData",
]);
export async function guidedBridgeCheck(
  name: MiniAppOperation,
  context: Context,
  signal: AbortSignal,
  supplied?: unknown,
): Promise<CheckOutcome> {
  const { client, interact } = context;
  const definition = cases[name];
  const input = supplied ?? definition.input;
  const call = async (
    operation: MiniAppOperation,
    value: unknown = cases[operation].input,
  ) => {
    signal.throwIfAborted();
    context.mutated?.(operation, value);
    const result = await client.call(operation, value as never, {
      signal,
      timeoutMs: 60000,
    });
    // A definite refusal creates no token. Throws/timeouts remain uncertain and
    // retain cleanup, as does any earlier successful write during a repeat.
    if (operation === "updateBiometryToken" && result === false)
      context.mutationRejected?.(operation);
    return result;
  };
  const question = async (request: Interaction): Promise<CheckOutcome> => {
    const answer = await interact(request, signal);
    if (answer.decision === "skip")
      return {
        state: "manual",
        detail: "Не проверено: пользователь пропустил шаг",
      };
    if (answer.decision === "no")
      throw new Error(
        "API вызван, но пользователь не подтвердил ожидаемый эффект на устройстве",
      );
    if (answer.value === false || answer.value === null)
      return {
        state: "manual",
        detail: "LO вернул отказ или отмену; успешный результат не подтверждён",
      };
    return {
      state: "passed",
      evidence: "device",
      detail:
        "Действие вызвано через мост; результат подтверждён пользователем на устройстве",
    };
  };
  if (
    [
      "setOrientationLock",
      "setClosingConfirmation",
      "setVerticalSwipes",
    ].includes(name)
  ) {
    const originalLock = client.adapter.snapshot().isOrientationLocked;
    let changed = false;
    const restore = async (cleanupSignal: AbortSignal) => {
      if (!changed) return;
      const restored = await client.call(
        name,
        (name === "setOrientationLock"
          ? { locked: originalLock ?? false }
          : { enabled: name === "setVerticalSwipes" }) as never,
        { signal: cleanupSignal, timeoutMs: 3000 },
      );
      if (restored === false)
        throw new Error("LO отклонил восстановление настройки");
    };
    // The runner owns restoration outside its action timeout. Standalone callers
    // still receive finally-based restoration with a fresh independent signal.
    context.deferCleanup?.(restore);
    const toggle = async (enabled: boolean) => {
      changed = true;
      const result = await call(
        name,
        name === "setOrientationLock" ? { locked: enabled } : { enabled },
      );
      if (result === false) throw new Error("LO отклонил изменение настройки");
      return result;
    };
    try {
      if (name === "setClosingConfirmation") {
        return await question({
          title: definition.label,
          detail:
            "Сначала сбросим настройку, затем включим её заново. Нажмите «Закрыть» в LO и отмените закрытие в появившемся подтверждении. Проверка отключения требует отдельного закрытия после прогона.",
          actionLabel: "Включить подтверждение",
          question:
            "LO показал подтверждение закрытия, и вы отменили закрытие?",
          action: async () => {
            await toggle(false);
            return toggle(true);
          },
        });
      }
      const orientation = name === "setOrientationLock";
      if (!orientation && client.adapter.snapshot().isFullscreen === true)
        return {
          state: "manual",
          detail:
            "В полном экране жест панели отключён независимо от настройки. Выйдите из полного экрана и повторите проверку.",
        };
      for (const [index, enabled] of (orientation
        ? [false, true, false]
        : [true, false, true]
      ).entries()) {
        const result = await question({
          title: `${definition.label} · ${index + 1}/3`,
          detail: orientation
            ? enabled
              ? "Поверните телефон. Ориентация должна остаться зафиксированной."
              : "Отключите системную блокировку поворота и поверните телефон. Если экран не поворачивается, этот сценарий подтвердить нельзя."
            : "В обычном режиме слегка потяните вниз верхнюю панель LO, где «Закрыть» и меню, затем отпустите. Не делайте длинный или быстрый свайп: он закроет приложение.",
          actionLabel: orientation
            ? enabled
              ? "Зафиксировать"
              : "Разрешить поворот"
            : enabled
              ? "Включить жест"
              : "Выключить жест",
          question: orientation
            ? enabled
              ? "Ориентация осталась зафиксированной?"
              : "Экран повернулся вслед за телефоном?"
            : enabled
              ? "Панель двигается за пальцем и возвращается после отпускания?"
              : "Панель перестала двигаться при том же коротком жесте?",
          action: () => toggle(enabled),
        });
        if (result.state !== "passed") return result;
      }
      return {
        state: "passed",
        evidence: "device",
        detail:
          "Пользователь подтвердил исходное поведение, противоположное состояние и возврат после нового вызова через этот мост",
      };
    } finally {
      if (!context.deferCleanup)
        await bounded(restore, new AbortController().signal, 4000);
    }
  }
  if (name === "ready") {
    await call(name);
    const snapshot = client.adapter.snapshot();
    if (!snapshot || typeof snapshot !== "object")
      throw new Error("Мост не вернул состояние приложения");
    return {
      state: "passed",
      evidence: "data",
      detail: "ready выполнен; snapshot получен из моста",
    };
  }
  if (name === "expand" && context.panelExpanded?.() === true) {
    await call(name);
    return {
      state: "manual",
      detail:
        "Панель уже развёрнута. Запрос expand выполнен; увеличение высоты проверить нельзя.",
    };
  }
  if (name === "haptic")
    return question({
      title: "Вибрация",
      detail:
        "Будут три сильных импульса с паузами. В симуляторе вибрацию проверить нельзя.",
      actionLabel: "Запустить вибрацию",
      question: "Почувствовали три импульса?",
      action: async () => {
        for (let i = 0; i < 3; i++) {
          await call(name, { kind: "heavy" });
          if (i < 2) await pause(700, signal);
        }
      },
    });
  if (/^set(Header|Background|BottomBar)Color$/.test(name)) {
    const theme = client.adapter.snapshot().theme;
    const original =
      (name === "setHeaderColor"
        ? theme?.headerBackground
        : name === "setBottomBarColor"
          ? theme?.bottomBarBackground
          : theme?.background) ??
      theme?.background ??
      "#f9fcff";
    let changed = false;
    try {
      return await question({
        title: definition.label,
        detail:
          name === "setHeaderColor"
            ? "Верхняя шапка мини-приложения LO с кнопкой «Закрыть» станет оранжевой, затем синей."
            : name === "setBottomBarColor"
              ? "Нижняя панель мини-приложения LO под страницей станет оранжевой, затем синей."
              : "Фон мини-приложения LO станет оранжевым, затем синим. Смотрите на свободные участки страницы вокруг карточек.",
        actionLabel: "Сменить цвета",
        question:
          name === "setHeaderColor"
            ? "Шапка LO поменяла цвет с оранжевого на синий?"
            : name === "setBottomBarColor"
              ? "Нижняя панель LO поменяла цвет с оранжевого на синий?"
              : "Фон вокруг карточек поменял цвет с оранжевого на синий?",
        action: async () => {
          changed = true;
          context.appearanceGuard?.(true, name);
          await call(name, { color: "#e87820" });
          await pause(1600, signal);
          await call(name, { color: "#2255cc" });
        },
      });
    } finally {
      // Restoration has its own signal: stop must not leave the app recoloured.
      try {
        if (changed)
          await bounded(
            (s) =>
              client.call(
                name,
                {
                  color: /^#[a-f0-9]{6}$/i.test(original)
                    ? original
                    : "#f9fcff",
                } as never,
                { signal: s },
              ),
            new AbortController().signal,
            3000,
          );
      } finally {
        context.appearanceGuard?.(false);
      }
    }
  }
  if (name === "setButton") {
    const button = (input as { button: string }).button;
    const event = `${button}ButtonClicked` as MiniAppEvent;
    const before = context.observed()[event];
    let shown = false;
    try {
      const result = await question({
        title: `Кнопка: ${button}`,
        detail:
          "Нажмите кнопку, которую покажет LO. Затем подтвердите результат здесь.",
        actionLabel: "Показать кнопку",
        question: "Кнопка появилась и вы нажали её?",
        action: () => {
          shown = true;
          return call(name, input);
        },
      });
      if (result.state === "passed" && context.observed()[event] === before)
        throw new Error(`Нажатие не подтверждено событием ${event}`);
      return result;
    } finally {
      if (shown)
        await bounded(
          (s) =>
            client.call(
              "setButton",
              { button, params: { visible: false } } as never,
              { signal: s },
            ),
          new AbortController().signal,
          3000,
        );
    }
  }
  if (/^start(Accelerometer|Gyroscope|DeviceOrientation)$/.test(name)) {
    const event = (
      {
        startAccelerometer: "accelerometerChanged",
        startGyroscope: "gyroscopeChanged",
        startDeviceOrientation: "orientationChanged",
      } as Record<string, string>
    )[name];
    const failureEvent = (
      {
        startAccelerometer: "accelerometerFailed",
        startGyroscope: "gyroscopeFailed",
        startDeviceOrientation: "orientationFailed",
      } as Record<string, string>
    )[name];
    let unavailable = false;
    const releaseFailure = client.on(
      failureEvent as MiniAppEvent,
      (payload) => {
        unavailable =
          (payload as { reason?: unknown } | undefined)?.reason ===
          "UNSUPPORTED";
      },
    );
    let sample: unknown;
    const release = client.on(event as MiniAppEvent, (payload) => {
      sample = payload;
    });
    try {
      const started = await call(name, input);
      if (started === false && unavailable)
        return {
          state: "manual",
          detail:
            "LO сообщил, что датчик недоступен (UNSUPPORTED). Получение данных не проверено; причина недоступности не установлена.",
        };
      if (started !== true) throw new Error("LO не запустил датчик");
      for (let i = 0; i < 80 && sample === undefined; i++)
        await pause(50, signal);
      const fields =
        name === "startDeviceOrientation"
          ? ["alpha", "beta", "gamma"]
          : ["x", "y", "z"];
      if (
        !sample ||
        !fields.every((key) =>
          Number.isFinite((sample as Record<string, unknown>)[key]),
        )
      )
        throw new Error(
          `Датчик запущен, но корректные данные ${event} не получены`,
        );
      return {
        state: "passed",
        evidence: "data",
        detail: `${event}: получен свежий образец; все координаты конечные числа`,
      };
    } finally {
      release();
      releaseFailure();
    }
  }
  if (/^stop(Accelerometer|Gyroscope|DeviceOrientation)$/.test(name)) {
    const event = (
      {
        stopAccelerometer: "accelerometerChanged",
        stopGyroscope: "gyroscopeChanged",
        stopDeviceOrientation: "orientationChanged",
      } as Record<string, string>
    )[name];
    if ((await call(name)) !== true) throw new Error("LO не остановил датчик");
    await pause(300, signal);
    let late = false;
    const release = client.on(event as MiniAppEvent, () => {
      late = true;
    });
    try {
      await pause(600, signal);
      if (late)
        throw new Error("После остановки датчик продолжает присылать данные");
    } finally {
      release();
    }
    return {
      state: "passed",
      evidence: "data",
      detail: "Остановка подтверждена; новых образцов после паузы не было",
    };
  }
  if (name === "getBiometryInfo") {
    const info = (await call(name)) as {
      available?: boolean;
      accessGranted?: boolean;
    };
    if (
      typeof info?.available !== "boolean" ||
      typeof info?.accessGranted !== "boolean"
    )
      throw new Error("Некорректный ответ биометрии");
    return {
      state: "passed",
      evidence: "data",
      detail: `Биометрия ${info.available ? "доступна" : "недоступна"}; разрешение ${info.accessGranted ? "есть" : "не выдано"}`,
    };
  }
  if (name === "getLocation") {
    const answer = await interact(
      {
        title: definition.label,
        detail:
          "LO запросит геопозицию. Координаты проверяются, но не сохраняются в отчёт.",
        action: () => call(name),
      },
      signal,
    );
    if (answer.decision === "skip" || answer.value === null)
      return { state: "manual", detail: "Геопозиция не получена" };
    const value = answer.value as { latitude?: number; longitude?: number };
    if (
      !Number.isFinite(value?.latitude) ||
      !Number.isFinite(value?.longitude) ||
      Math.abs(value.latitude!) > 90 ||
      Math.abs(value.longitude!) > 180
    )
      throw new Error("LO вернул некорректную геопозицию");
    return {
      state: "passed",
      evidence: "data",
      detail: "Получены допустимые координаты; значения скрыты",
    };
  }
  if (name === "readClipboard") {
    const marker = "LO SDK Test";
    const answer = await interact(
      {
        title: "Буфер обмена",
        detail:
          "Выделите и скопируйте текст ниже, затем запустите чтение. Содержимое буфера в отчёт не попадёт.",
        input: { label: "Тестовый текст", value: marker, readOnly: true },
        actionLabel: "Прочитать через LO",
        action: () => call(name),
      },
      signal,
    );
    if (answer.decision === "skip")
      return { state: "manual", detail: "Чтение буфера не проверено" };
    if (answer.value === null)
      return {
        state: "manual",
        detail:
          "LO не предоставил доступ к тексту буфера (null). Установка приложения в библиотеке, недавнее нажатие и разрешение ОС не подтверждены; содержимое не проверено.",
      };
    if (answer.value !== marker)
      throw new Error("Буфер не вернул скопированный тестовый текст");
    return {
      state: "passed",
      evidence: "data",
      detail: "Скопированный тестовый текст совпал; содержимое скрыто",
    };
  }
  if (name === "showPopup") {
    const answer = await interact(
      {
        title: definition.label,
        detail: "В диалоге LO нажмите OK.",
        action: () => call(name),
      },
      signal,
    );
    if (answer.decision === "skip")
      return { state: "manual", detail: "Диалог не проверен" };
    if (answer.value !== "ok")
      throw new Error("Диалог LO не вернул ожидаемую кнопку ok");
    return {
      state: "passed",
      evidence: "data",
      detail: "Диалог LO вернул выбранную кнопку ok",
    };
  }
  if (name === "requestBiometryAccess" || name === "authenticateBiometry") {
    const answer = await interact(
      {
        title: definition.label,
        detail:
          "Выполните запрос в LO. Отказ не будет засчитан как успешная проверка.",
        action: () => call(name, input),
      },
      signal,
    );
    if (
      answer.decision === "skip" ||
      answer.value === false ||
      (name === "authenticateBiometry" &&
        !(answer.value as { authenticated?: boolean })?.authenticated)
    )
      return { state: "manual", detail: "Биометрия не подтверждена" };
    return {
      state: "passed",
      evidence: "data",
      detail: "LO подтвердил биометрию; токены и ID устройства не сохраняются",
    };
  }
  if (name === "requestWriteAccess") {
    const answer = await interact(
      {
        title: "Разрешение на сообщения",
        detail: "Проверяется запрос разрешения через этот мост LO.",
        action: () => call(name),
      },
      signal,
    );
    if (answer.decision === "skip" || answer.value !== true)
      return {
        state: "manual",
        detail: "Разрешение через этот мост не подтверждено",
      };
    return {
      state: "passed",
      evidence: "data",
      detail: "Этот мост вернул подтверждённое разрешение",
    };
  }
  if (name === "deviceStorageClear" || name === "secureStorageClear") {
    const storage =
      name === "deviceStorageClear" ? "deviceStorage" : "secureStorage";
    const probe = `lo-sdk-clear-${crypto.randomUUID()}`;
    const answer = await interact(
      {
        title: definition.label,
        detail:
          "Удалит все данные хранилища только LO SDK Test. Перед очисткой будет создан контрольный ключ, после — проверено его отсутствие.",
        action: async () => {
          if (
            (await call(`${storage}Set`, {
              key: probe,
              value: "clear-probe",
            })) !== true
          )
            throw new Error("Контрольный ключ не записан");
          try {
            if ((await call(name)) !== true)
              throw new Error("LO не подтвердил очистку");
            const result = await call(`${storage}Get`, { key: probe });
            if (
              storage === "secureStorage"
                ? (result as { value?: unknown })?.value != null
                : result != null && result !== ""
            )
              throw new Error("Контрольный ключ остался после очистки");
          } finally {
            await bounded(
              (s) =>
                client.call(`${storage}Remove`, { key: probe } as never, {
                  signal: s,
                }),
              new AbortController().signal,
              3000,
            );
          }
        },
      },
      signal,
    );
    return answer.decision === "skip"
      ? { state: "manual", detail: "Очистка не запускалась" }
      : {
          state: "passed",
          evidence: "data",
          detail:
            "Очистка вызвана; отсутствие предварительно записанного ключа проверено чтением",
        };
  }
  if (name === "secureStorageRestore") {
    const key = (input as { key: string }).key;
    const current = (await call("secureStorageGet", { key })) as {
      canRestore?: boolean;
    };
    if (!current?.canRestore)
      return {
        state: "manual",
        detail:
          "LO не предлагает восстановление тестового ключа; положительный сценарий сейчас недоступен",
      };
    const answer = await interact(
      {
        title: definition.label,
        detail: "Восстановит только ключ текущего прогона.",
        action: () => call(name, input),
      },
      signal,
    );
    if (answer.decision === "skip")
      return { state: "manual", detail: "Восстановление не проверено" };
    if (answer.value !== "SDK Test roundtrip")
      throw new Error("Восстановленное значение не совпадает с записанным");
    return {
      state: "passed",
      evidence: "data",
      detail: "Восстановлено ранее записанное значение тестового ключа",
    };
  }
  if (name === "updateBiometryToken") {
    const answer = await interact(
      {
        title: definition.label,
        detail:
          "Сохранит тестовый токен только для LO SDK Test. При завершении он будет удалён.",
        action: () => call(name, input),
      },
      signal,
    );
    if (answer.decision === "skip" || answer.value !== true)
      return { state: "manual", detail: "Токен не записан" };
    const info = (await call("getBiometryInfo")) as { tokenSaved?: boolean };
    if (info?.tokenSaved !== true)
      throw new Error("После записи LO не подтвердил наличие токена");
    return {
      state: "passed",
      evidence: "data",
      detail: "Запись подтверждена tokenSaved; токен не сохраняется в отчёт",
    };
  }
  const questions: Partial<Record<MiniAppOperation, string>> = {
    expand: "Панель мини-приложения стала выше?",
    requestFullscreen: "LO перешёл в полный экран?",
    exitFullscreen: "LO вышел из полного экрана?",
    hideKeyboard: "Клавиатура скрылась?",
    openLink: "Открылся сайт lo.ink? Вернитесь в LO.",
    switchInlineQuery:
      "Открылся выбор чата? Нажмите «Отмена», чтобы вернуться к проверке.",
    openLocationSettings: "Открылись настройки геопозиции?",
    openBiometrySettings: "Открылись настройки биометрии?",
    updateBiometryToken: "Тестовый токен сохранён?",
    downloadFile: "Файл sdk-test.txt действительно сохранён или открыт?",
    openQrScanner: "Открылся сканер LO?",
    closeQrScanner: "Сканер закрылся?",
    requestContact: "LO запросил контакт и подтвердил его передачу?",
    shareMessage: "Открылось подготовленное сообщение?",
    shareToStory:
      "Открылся редактор истории с тестовым изображением? Отмените публикацию.",
    openInvoice: "Открылся тестовый счёт? Отмените оплату.",
    deviceStorageClear: "Хранилище очищено?",
    secureStorageClear: "Защищённое хранилище очищено?",
    secureStorageRestore: "Восстановление ключа завершилось?",
  };
  let promptInput: Interaction["input"];
  if (name === "shareMessage")
    promptInput = {
      label: "ID подготовленного тестового сообщения",
      placeholder: "Без ID этот мост останется непроверенным",
    };
  if (name === "openInvoice")
    promptInput = {
      label: "Ссылка на тестовый счёт",
      placeholder: "Не используйте реальный платёж",
    };
  return question({
    title: definition.label,
    detail:
      "caution" in definition
        ? definition.caution
        : name === "expand"
          ? "Панель мини-приложения должна стать выше. Кнопки LO останутся на экране."
          : name === "hideKeyboard"
            ? "Коснитесь поля, чтобы открыть клавиатуру, затем нажмите «Проверить»."
            : (questions[name] ??
              "Выполните действие и проверьте результат в LO."),
    input:
      promptInput ??
      (name === "hideKeyboard"
        ? {
            label: "Поле для клавиатуры",
            value: "SDK Test",
            preserveFocus: true,
          }
        : undefined),
    question: questions[name] ?? "Действие выполнено?",
    action: (text) =>
      call(
        name,
        name === "shareMessage"
          ? { id: text.trim() }
          : name === "openInvoice"
            ? { url: text.trim() }
            : input,
      ),
  });
}
