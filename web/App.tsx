import {
  Button,
  TextField,
  Heading,
  Text,
  Dialog,
  TextArea,
  Surface,
  Stack,
} from "@lo-ink/ui";
import { useEffect, useRef, useState } from "react";
import {
  bindSafeAreaCss,
  createLoClient,
  type MiniAppClient,
  type MiniAppOperation,
} from "@lo-ink/miniapp-sdk";
import { cases, events, operationNames } from "./cases.ts";
import { applyPalette } from "./theme.ts";
import { SecretaryPage } from "./SecretaryPage.tsx";
import { UiPage } from "./UiPage.tsx";
import { RunPage } from "./RunPage.tsx";
import {
  bounded,
  canResume,
  matchesPlan,
  hasRecoveryDebt,
  bridgeCoverage,
  runChecks,
  summarize,
  type Check,
  type RunReport,
} from "./runner.ts";
import { createSuite } from "./suite.ts";
import { beginWriteAccess, type WriteAccessResult } from "./consent.ts";
import sdkBuild from "../sdk-build.json";
import { version as appVersion } from "../package.json";
import { beginAudio, type AudioStart } from "./audio.ts";
import { createInteraction, type InteractionView } from "./interaction.ts";
import { availableBridges } from "./bridges.ts";
import { guidedBridgeCheck } from "./bridge-checks.ts";
import { systemThemeChecks } from "./system-theme.ts";
import { ActionConfirmation } from "./ActionConfirmation.tsx";
import {
  applyDeferredResult,
  createDeferredTicket,
  createDeliveryCheck,
  deferredIdentity,
  deferredKey,
  ownsDeferredTicket,
  readDeferredTicket,
  persistDeferredResult,
  verifyDeferredData,
  type DeferredTicket,
} from "./deferred.ts";

import { dependencyKey, readRun, saveRun, sameOwner } from "./run-storage.ts";
const dependencies = dependencyKey(sdkBuild.packages);

type Result = {
  state: "running" | "done" | "denied" | "failed";
  detail: string;
  time: string;
};
type Entry = { time: string; label: string; detail: string };
type Configuration = {
  appConfigured: boolean;
  botConfigured: boolean;
  origin: string | null;
};
const time = () => new Date().toLocaleTimeString("ru-RU");
function display(value: unknown, operation = ""): string {
  if (operation === "qrTextReceived") return "QR получен; содержимое скрыто";
  if (operation === "readClipboard")
    return typeof value === "string"
      ? `Получено ${value.length} символов; содержимое скрыто`
      : "Буфер недоступен";
  if (value === undefined) return "";
  return (
    JSON.stringify(
      value,
      (key, v) =>
        /token|hash|signature|initdata|queryid/i.test(key) ? "[скрыто]" : v,
      2,
    ) ?? ""
  );
}
async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    credentials: "same-origin",
    signal,
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", "x-sdk-test": "1" },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok) {
    const pause = Number.isFinite(result.retryAfterSec)
      ? `; пауза ${result.retryAfterSec} с`
      : "";
    throw Object.assign(
      new Error(
        `${result.message ?? `Ошибка ${response.status}`}${result.code ? ` (${result.code}${pause})` : ""}`,
      ),
      { code: result.code, reason: result.reason, status: response.status },
    );
  }
  return result as T;
}
export function App() {
  const [client, setClient] = useState<MiniAppClient | null>(null);
  const clientRef = useRef(client);
  clientRef.current = client;
  const [tab, setTab] = useState("Все проверки");
  const [results, setResults] = useState<Record<string, Result>>({});
  const [log, setLog] = useState<Entry[]>([]);
  const [filter, setFilter] = useState("");
  const [group, setGroup] = useState("Все");
  const [configuration, setConfiguration] = useState<Configuration | null>(
    null,
  );
  const [authenticated, setAuthenticated] = useState(false);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [backendMessage, setBackendMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [audioState, setAudioState] = useState("Не запускался");
  const [selected, setSelected] = useState<MiniAppOperation | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    name: MiniAppOperation;
    supplied?: unknown;
    caution: string;
  } | null>(null);
  const [input, setInput] = useState("");
  const [eventValues, setEventValues] = useState<Record<string, string>>({});
  const [insets, setInsets] = useState("Нет данных LO");
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [reportText, setReportText] = useState("");
  const controllers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const audio = useRef<AudioContext | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const reportDialog = useRef<HTMLDialogElement>(null);
  const [automatedRun, setAutomatedRun] = useState<RunReport | null>(() =>
    readRun(localStorage, dependencies),
  );
  const automatedRunRef = useRef(automatedRun);
  automatedRunRef.current = automatedRun;
  const includeBot = true;
  const [resumingRun, setResumingRun] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const [stoppingRun, setStoppingRun] = useState(false);
  const runController = useRef<AbortController | null>(null);
  const runEvents = useRef<Record<string, string> | null>(null);
  const [interaction, setInteraction] = useState<InteractionView | null>(null);
  const testingAppearance = useRef(false);
  const interactionController = useRef<AbortController | null>(null);
  const deferredBusy = useRef(false);
  const [deferredRevision, setDeferredRevision] = useState(0);
  const finishDeferred = (
    ticket: DeferredTicket,
    result: Parameters<typeof applyDeferredResult>[2],
  ) => {
    if (!mounted.current) return;
    try {
      const report = persistDeferredResult(
        localStorage,
        automatedRunRef.current,
        ticket,
        result,
        appVersion,
        dependencies,
        clientRef.current ? deferredIdentity(clientRef.current) : null,
      );
      if (report !== automatedRunRef.current) {
        automatedRunRef.current = report;
        setAutomatedRun(report);
      }
    } catch {
      setExportMessage(
        "Не удалось сохранить результат. Попытка остаётся незавершённой; повторите подтверждение после открытия приложения.",
      );
    }
  };
  useEffect(() => {
    if (!client) return;
    const identity = deferredIdentity(client);
    if (!identity) return;
    const ticket = readDeferredTicket(
      localStorage,
      automatedRun,
      appVersion,
      identity,
    );
    if (!ticket) return;
    const controller = new AbortController();
    interactionController.current = controller;
    const request = createInteraction(setInteraction);
    const verifyData = (signal: AbortSignal) =>
      verifyDeferredData(ticket, client.adapter.launchData, api, signal, () => {
        if (mounted.current) setAuthenticated(true);
      });
    void request(
      ticket.operation === "delivery"
        ? {
            title: "Доставка файлов после прогона",
            detail: `Восстановление завершено, отчёт сохранён. Проверьте уже отправленные файлы прогона от ${new Date(automatedRun!.startedAt).toLocaleString("ru-RU")}: 2 фото, 2 документа и 2 голосовых файла. Текстовое сообщение проверяется отдельно тестом deleteMessage. Через меню LO перейдите в чат бота, затем снова откройте LO SDK Test: эта проверка продолжится без новых отправок.`,
            question: "Файлы этого прогона появились в чате тестового бота?",
          }
        : ticket.operation === "close"
          ? {
              title: "Результат закрытия",
              detail:
                "Подтвердите результат последней попытки закрытия этого прогона.",
              question:
                "Мини-приложение действительно закрылось после нажатия?",
            }
          : {
              title: "Результат отправки данных",
              detail: `Проверим у тестового бота только код этой попытки: ${ticket.data}. Старые тестовые сообщения не учитываются. Если код ещё не найден, можно повторить проверку после открытия приложения.`,
              actionLabel: "Проверить получение у бота",
              action: () => bounded(verifyData, controller.signal, 15000),
            },
      controller.signal,
    )
      .then((answer) => {
        if (controller.signal.aborted) return;
        const passed =
          answer.decision === "yes" &&
          (ticket.operation !== "sendData" || answer.value === true);
        finishDeferred(ticket, {
          state: passed
            ? "passed"
            : answer.decision === "no"
              ? "failed"
              : "manual",
          evidence: passed
            ? ticket.operation === "sendData"
              ? "data"
              : "device"
            : undefined,
          detail: passed
            ? ticket.operation === "sendData"
              ? `Бот вернул appData с кодом ${ticket.data} для подписанного пользователя этой попытки`
              : ticket.operation === "delivery"
                ? "Доставка файлов этого прогона подтверждена пользователем после восстановления"
                : "Закрытие подтверждено после повторного открытия"
            : answer.decision === "no"
              ? "Пользователь не подтвердил результат"
              : "Результат не проверен",
        });
      })
      .catch((error) => {
        // Keep the exact attempt for another read-only probe; never resend on failure.
        if (!controller.signal.aborted && mounted.current)
          setExportMessage(
            error instanceof Error
              ? error.message
              : "Получение данных не подтверждено",
          );
      });
    return () => controller.abort();
  }, [client, deferredRevision]);
  const runDeferred = (id: string) => {
    if (
      !automatedRun ||
      runController.current ||
      deferredBusy.current ||
      interaction
    )
      return;
    const bridges = id === "bot:delivery" ? [] : availableBridges();
    const target =
      id === "bot:delivery"
        ? client
        : bridges.find((bridge) => bridge.id === id.split(":")[0])?.client;
    const dispose = () => {
      for (const bridge of bridges) bridge.client?.dispose();
    };
    const identity = target ? deferredIdentity(target) : null;
    if (!target || !identity) {
      dispose();
      setExportMessage(
        "Откройте тест из LO заново: для этой проверки нужны данные запуска приложения и пользователя.",
      );
      return;
    }
    // A repeat of a pending sendData checks its original nonce, never resends it.
    const pending = readDeferredTicket(
      localStorage,
      automatedRun,
      appVersion,
      identity,
    );
    if (pending) {
      dispose();
      setDeferredRevision((value) => value + 1);
      return;
    }
    let ticket: DeferredTicket;
    try {
      ticket = createDeferredTicket(automatedRun, id, appVersion, identity);
    } catch {
      dispose();
      setExportMessage(
        "Эта проверка недоступна для текущего отчёта или пользователя LO. Нужен завершённый прогон этого пользователя с успешным восстановлением.",
      );
      return;
    }
    try {
      saveRun(localStorage, automatedRun, appVersion, dependencies);
      localStorage.setItem(deferredKey, JSON.stringify(ticket));
    } catch {
      dispose();
      setExportMessage(
        "Сначала сохраните отчёт: браузер не разрешил сохранить попытку перед закрытием.",
      );
      return;
    }
    if (ticket.operation === "delivery") {
      dispose();
      setDeferredRevision((value) => value + 1);
      return;
    }
    deferredBusy.current = true;
    void target
      .call(
        ticket.operation,
        (ticket.operation === "sendData"
          ? { data: ticket.data! }
          : undefined) as never,
      )
      .then((value: unknown) => {
        if (value === false) {
          finishDeferred(ticket, {
            state: "failed",
            detail: "LO отклонил завершающее действие",
          });
        } else if (
          ticket.operation === "sendData" &&
          mounted.current &&
          ownsDeferredTicket(localStorage, ticket)
        ) {
          setDeferredRevision((value) => value + 1);
        }
      })
      .catch((error) => {
        if (!ownsDeferredTicket(localStorage, ticket)) return;
        // A timeout may follow delivery. Preserve the nonce for correlation.
        if (ticket.operation === "sendData") {
          if (mounted.current) {
            setExportMessage(
              `Ответ LO не подтверждён; проверим получение по коду попытки. ${error instanceof Error ? error.message : ""}`,
            );
            setDeferredRevision((value) => value + 1);
          }
        } else
          finishDeferred(ticket, {
            state: "failed",
            detail:
              error instanceof Error
                ? error.message
                : "LO не выполнил действие",
          });
      })
      .finally(() => {
        deferredBusy.current = false;
        dispose();
      });
  };
  const runningAll = startingRun || automatedRun?.state === "running";
  const startAll = async (resume = false) => {
    if (
      runController.current ||
      deferredBusy.current ||
      interaction ||
      controllers.current.size ||
      Object.values(results).some((r) => r.state === "running")
    )
      return;
    if (!resume && hasRecoveryDebt(automatedRunRef.current)) {
      setExportMessage(
        "Сначала восстановите состояние прежнего прогона кнопкой продолжения. Новый запуск не должен потерять незавершённую очистку.",
      );
      return;
    }
    const previous = resume ? automatedRunRef.current : null;
    if (resume && !canResume(previous)) return;
    const bridges = availableBridges();
    const primary = bridges.find((bridge) => bridge.client) ?? bridges[0];
    const runClient = primary.client;
    const runOwner = runClient
      ? (deferredIdentity(runClient) ?? undefined)
      : undefined;
    if (previous && !sameOwner(previous, runOwner)) {
      setExportMessage(
        "Этот прогон относится к другому пользователю или приложению. Откройте его в прежнем аккаунте LO либо начните новый.",
      );
      return;
    }
    const runId = previous?.id ?? crypto.randomUUID();
    const controller = new AbortController();
    runController.current = controller;
    setResumingRun(resume);
    setConsent(null);
    setExportMessage("");
    try {
      localStorage.removeItem(deferredKey);
    } catch {
      /* Run identity also fences old tickets. */
    }
    runEvents.current = {};
    let resolveAudio!: (value: AudioStart | PromiseLike<AudioStart>) => void;
    const audioStarted = new Promise<AudioStart>((resolve) => {
      resolveAudio = resolve;
    });
    let resolveWrite!: (
      value: WriteAccessResult | PromiseLike<WriteAccessResult>,
    ) => void;
    const writeAccess =
      includeBot &&
      configuration?.botConfigured !== false &&
      runClient?.supports("requestWriteAccess")
        ? new Promise<WriteAccessResult>((resolve) => {
            resolveWrite = resolve;
          })
        : undefined;
    setStartingRun(true);
    setStoppingRun(false);
    const interact = createInteraction((view) => {
      if (mounted.current) setInteraction(view);
    });
    const subscriptions: Array<() => void> = [];
    const observed = new Map(
      bridges.map((bridge) => [bridge.id, {} as Record<string, string>]),
    );
    for (const bridge of bridges)
      for (const event of events) {
        try {
          if (bridge.client)
            subscriptions.push(
              bridge.client.on(event, (payload) => {
                observed.get(bridge.id)![event] =
                  `${performance.now()} · ${display(payload, event)}`;
              }),
            );
        } catch {
          /* Missing events remain unverified. */
        }
      }
    const common = {
      api,
      consent: null,
      includeBot,
      interact,
      audioStarted,
      playAudio: async () => {
        audio.current ??= new AudioContext();
        const started = await beginAudio(audio.current);
        if (started.state !== "running")
          throw new Error("LO не запустил звуковой контекст");
        const oscillator = audio.current.createOscillator();
        const gain = audio.current.createGain();
        gain.gain.value = 0.12;
        oscillator.frequency.value = 440;
        oscillator.connect(gain);
        gain.connect(audio.current.destination);
        oscillator.start();
        oscillator.stop(audio.current.currentTime + 0.3);
      },
      appearanceGuard: (testing: boolean, operation?: MiniAppOperation) => {
        testingAppearance.current = testing;
        document.documentElement.classList.toggle(
          "observe-lo-background",
          testing && operation === "setBackgroundColor",
        );
      },
      consentChanged: (allowed: boolean) => {
        if (mounted.current) setConsent(allowed);
      },
      verified: () => {
        if (mounted.current) setAuthenticated(true);
      },
      audioState: () => audio.current?.state ?? "unavailable",
    };
    let latestReport: RunReport | null = null;
    const themes = systemThemeChecks(bridges, interact);
    const plan: Check[] = [];
    const cleanups: Check[] = [];
    const suites = new Map<string, ReturnType<typeof createSuite>>();
    const publishReport = (update: RunReport) => {
      const report = {
        ...update,
        owner: runOwner,
        recovery: Object.fromEntries(
          [...suites].map(([id, suite]) => [id, suite.checkpoint()]),
        ),
      };
      latestReport = report;
      if (!mounted.current) return;
      automatedRunRef.current = report;
      setAutomatedRun(report);
      try {
        saveRun(localStorage, report, appVersion, dependencies);
      } catch {
        /* The live report remains available. */
      }
      setStartingRun(false);
    };
    for (const bridge of [
      primary,
      ...bridges.filter((item) => item !== primary),
    ]) {
      const suite = createSuite({
        ...common,
        runId,
        bridgeId: bridge.id,
        primary: bridge === primary,
        resumeChecks: previous?.checks
          .filter(
            (check) =>
              check.bridge === bridge.label ||
              (bridge === primary && !check.bridge),
          )
          .map((check) => ({
            ...check,
            id: check.id.startsWith(`${bridge.id}:`)
              ? check.id.slice(bridge.id.length + 1)
              : check.id,
          })),
        recovery: previous?.recovery?.[bridge.id],
        checkpoint: () => {
          if (latestReport) publishReport(latestReport);
        },
        client: bridge.client,
        panelExpanded: bridge.panelExpanded,
        observed: () => observed.get(bridge.id)!,
        writeAccess: bridge === primary ? writeAccess : undefined,
        supportsOperation: bridge.native
          ? (name, input) => bridge.native!.nativeSupports(name, input as never)
          : undefined,
      });
      suites.set(bridge.id, suite);
      for (const check of suite.plan) {
        const host =
          operationNames.includes(check.id as MiniAppOperation) ||
          check.id.startsWith("button:");
        const event = check.id.startsWith("event:");
        if (bridge !== primary && !host && !event) continue;
        if (bridge !== primary && check.id === "requestWriteAccess") {
          check.skip = () =>
            !bridge.client?.supports("requestWriteAccess")
              ? {
                  state: "skipped",
                  detail: "Этот мост не поддерживает разрешение на сообщения",
                }
              : undefined;
          check.execute = (signal) =>
            guidedBridgeCheck(
              "requestWriteAccess",
              {
                client: bridge.client!,
                interact,
                observed: () => observed.get(bridge.id)!,
              },
              signal,
            );
        }
        plan.push({
          ...check,
          id: host || event ? `${bridge.id}:${check.id}` : check.id,
          bridge: host || event ? bridge.label : undefined,
          group:
            host || event ? `${bridge.label} · ${check.group}` : check.group,
        });
        if (bridge === primary && check.id === "audio-playback")
          plan.push(...themes);
      }
      cleanups.push({
        ...suite.cleanup,
        id: `${bridge.id}:cleanup`,
        label: `${bridge.label}: восстановление`,
      });
    }
    if (includeBot) plan.push(createDeliveryCheck(() => latestReport));
    const cleanup: Check = {
      id: "cleanup",
      label: "Восстановление после прогона",
      group: "Завершение",
      timeoutMs: 45000,
      execute: async (signal) => {
        const errors: string[] = [];
        for (const check of cleanups) {
          if (check.skip?.()) continue;
          try {
            await bounded(check.execute, signal, 20000);
          } catch (error) {
            errors.push(
              `${check.label}: ${error instanceof Error ? error.message : "ошибка"}`,
            );
          }
        }
        if (errors.length) throw new Error(errors.join("; "));
        return "Тестовые ключи удалены, настройки экрана восстановлены и датчики остановлены";
      },
    };
    try {
      if (previous && !matchesPlan(previous, [...plan, cleanup]))
        throw new Error(
          "Набор проверок изменился. Сохранённый отчёт доступен; начните новый прогон.",
        );
      resolveAudio(beginAudio(audio.current));
      if (writeAccess && runClient)
        resolveWrite(beginWriteAccess(runClient, controller.signal));
      await runChecks(plan, cleanup, controller.signal, publishReport, 12000, {
        id: runId,
        ...(previous
          ? {
              previous,
              prepare: async (signal) => {
                for (const suite of suites.values())
                  await suite.prepareResume(signal);
              },
            }
          : {}),
      });
    } catch (error) {
      if (mounted.current)
        setExportMessage(
          error instanceof Error
            ? error.message
            : "Не удалось запустить проверку",
        );
    } finally {
      for (const release of subscriptions) release();
      testingAppearance.current = false;
      setInteraction(null);
      runController.current = null;
      runEvents.current = null;
      if (mounted.current) {
        setStartingRun(false);
        setStoppingRun(false);
        setResumingRun(false);
      }
    }
  };
  const launch = client?.launchUnsafe();
  const selectSample = async (
    kind: "photo" | "document" | "voice" | "video",
  ) => {
    try {
      if (kind === "document") {
        setFile(
          new File(
            ["LO SDK Test: UTF-8 document upload. Проверка файла.\n"],
            "sdk-test.txt",
            { type: "text/plain" },
          ),
        );
        return;
      }
      const response = await fetch(
        kind === "photo"
          ? "/icon.png"
          : kind === "video"
            ? "/sdk-test.mp4"
            : "/sdk-test.m4a",
      );
      if (!response.ok) throw new Error("Sample unavailable");
      setFile(
        new File(
          [await response.blob()],
          kind === "photo"
            ? "sdk-test.png"
            : kind === "video"
              ? "sdk-test.mp4"
              : "sdk-test.m4a",
          {
            type:
              kind === "photo"
                ? "image/png"
                : kind === "video"
                  ? "video/mp4"
                  : "audio/mp4",
          },
        ),
      );
    } catch {
      setBackendMessage("Не удалось загрузить пример. Повторите выбор файла.");
    }
  };
  const record = (label: string, detail: string) =>
    setLog((previous) =>
      [{ time: time(), label, detail }, ...previous].slice(0, 100),
    );
  const complete = (
    name: string,
    value: unknown,
    state: Result["state"] = "done",
  ) => {
    const detail = display(value, name);
    if (!mounted.current) return;
    setResults((previous) => ({
      ...previous,
      [name]: { state, detail, time: time() },
    }));
    record(name, detail);
  };
  useEffect(() => {
    mounted.current = true;
    const releases: Array<() => void> = [];
    const next = createLoClient();
    setClient(next);
    let frameColor = "";
    const appearance = () => {
      const snapshot = next?.adapter.snapshot();
      const scheme =
        snapshot?.colorScheme ??
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      document.documentElement.dataset.loTheme = scheme;
      const colors = snapshot?.theme;
      const hostColor = (value: string | undefined) =>
        value && /^#[a-f0-9]{6}$/i.test(value) ? value : undefined;
      applyPalette(document.documentElement, "lo", scheme, {
        bg_color: hostColor(colors?.background),
        secondary_bg_color: hostColor(colors?.secondaryBackground),
        text_color: hostColor(colors?.text),
        button_color: hostColor(colors?.action),
        button_text_color: hostColor(colors?.actionText),
      });
      document.documentElement.style.setProperty(
        "--muted",
        scheme === "dark" ? "#a4adbd" : "#5f6878",
      );
      document.documentElement.style.setProperty(
        "--hairline",
        scheme === "dark" ? "#33405c" : "#e5eaf2",
      );
      // Theme events remain observable during colour tests; only our automatic
      // writeback must stop, otherwise it would overwrite the bridge under test.
      if (testingAppearance.current) return;
      // LO owns the area below the WebView, including the home indicator.
      // Match it to the page so the document doesn't end at a white strip.
      const pageColor =
        document.documentElement.style.getPropertyValue("--page");
      if (pageColor !== frameColor) {
        frameColor = pageColor;
        if (next?.supports("bottomBarColor"))
          void next
            .call("setBottomBarColor", { color: pageColor })
            .catch((error: unknown) =>
              complete(
                "appearance:setBottomBarColor",
                error instanceof Error
                  ? error.message
                  : "Ошибка цвета интерфейса",
                "failed",
              ),
            );
        if (next?.supports("backgroundColor"))
          void next
            .call("setBackgroundColor", { color: pageColor })
            .catch((error: unknown) =>
              complete(
                "appearance:setBackgroundColor",
                error instanceof Error
                  ? error.message
                  : "Ошибка цвета интерфейса",
                "failed",
              ),
            );
      }
    };
    appearance();
    try {
      audio.current = new AudioContext();
      void audio.current
        .resume()
        .then(() => {
          if (mounted.current) setAudioState(audio.current?.state ?? "closed");
        })
        .catch(() => {
          if (mounted.current)
            setAudioState("Заблокирован; повторите касанием");
        });
      const audioTimer = setTimeout(() => {
        if (mounted.current) setAudioState(audio.current?.state ?? "closed");
      }, 500);
      releases.push(() => clearTimeout(audioTimer));
    } catch {
      setAudioState("Web Audio недоступен");
    }
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", appearance);
    releases.push(() => media.removeEventListener("change", appearance));
    if (next) {
      releases.push(bindSafeAreaCss(next));
      const latest = new Map<string, number>();
      for (const event of events) {
        try {
          releases.push(
            next.on(event, (payload) => {
              if (runEvents.current)
                runEvents.current[event] = display(payload, event);
              if (Date.now() - (latest.get(event) ?? 0) < 250) return;
              latest.set(event, Date.now());
              if (event === "themeChanged") appearance();
              if (event === "deactivated") void audio.current?.suspend();
              setEventValues((previous) => ({
                ...previous,
                [event]: display(payload, event),
              }));
              record(event, display(payload, event));
            }),
          );
        } catch {
          /* A missing event is shown as unsupported, never passed. */
        }
      }
      const updateInsets = () =>
        setInsets(
          ["top", "right", "bottom", "left"]
            .map(
              (edge) =>
                `${edge}: ${document.documentElement.style.getPropertyValue(`--lo-safe-${edge}`) || "env()"}`,
            )
            .join(" · "),
        );
      updateInsets();
      for (const event of [
        "safeAreaChanged",
        "contentSafeAreaChanged",
        "viewportChanged",
      ] as const)
        try {
          releases.push(next.on(event, updateInsets));
        } catch {
          /* Old hosts can omit these events. */
        }
    }
    void api<Configuration>("status")
      .then(setConfiguration)
      .catch(() =>
        setBackendMessage(
          "Сервер недоступен. Запустите npm start и повторите проверку.",
        ),
      );
    return () => {
      mounted.current = false;
      runController.current?.abort();
      for (const controller of controllers.current.values()) controller.abort();
      for (const release of releases) release();
      next?.dispose();
      void audio.current?.close();
    };
  }, []);
  useEffect(() => {
    if (selected && dialog.current && !dialog.current.open)
      dialog.current.showModal();
  }, [selected]);
  useEffect(() => {
    if (reportText && reportDialog.current && !reportDialog.current.open)
      reportDialog.current.showModal();
  }, [reportText]);
  const run = async (
    name: MiniAppOperation,
    supplied?: unknown,
    confirmed = false,
  ) => {
    if (!client) return;
    const definition = cases[name];
    const caution = "caution" in definition ? definition.caution : undefined;
    if (caution && !confirmed) {
      setPendingAction({ name, supplied, caution });
      return;
    }
    if (controllers.current.has(name)) return;
    const controller = new AbortController();
    controllers.current.set(name, controller);
    setResults((previous) => ({
      ...previous,
      [name]: {
        state: "running",
        detail: "Ожидаем ответ LO…",
        time: time(),
      },
    }));
    try {
      const value = await client.call(
        name,
        (supplied ?? definition.input) as never,
        { signal: controller.signal },
      );
      complete(name, value, value === false ? "denied" : "done");
      if (name === "requestWriteAccess") {
        setConsent(value as boolean);
        if (authenticated) await saveConsent(value as boolean);
      }
    } catch (error) {
      complete(
        name,
        error instanceof Error ? error.message : "Ошибка приложения LO",
        "failed",
      );
    } finally {
      controllers.current.delete(name);
    }
  };
  const saveConsent = async (allowed = consent) => {
    if (allowed === null) return;
    try {
      await api("consent", { allowed });
      setBackendMessage("Ответ о согласии принят сервером");
    } catch {
      setBackendMessage(
        "Не удалось сохранить разрешение на сервере. Повторите отправку.",
      );
    }
  };
  const authenticate = async () => {
    if (!client) return;
    try {
      const result = await api("session", { raw: client.adapter.launchData });
      setAuthenticated(true);
      complete("verifyInitData", result);
      setConsent(null);
    } catch (error) {
      complete(
        "verifyInitData",
        error instanceof Error ? error.message : "Подпись отклонена",
        "failed",
      );
    }
  };
  const bot = async (operation: string) => {
    if (results[`bot:${operation}`]?.state === "running") return;
    setResults((previous) => ({
      ...previous,
      [`bot:${operation}`]: {
        state: "running",
        detail: "Отправляем тест…",
        time: time(),
      },
    }));
    try {
      // File bytes are encoded in bounded chunks to avoid call-stack overflow.
      let data: string | undefined;
      if (
        file &&
        ["sendPhoto", "sendDocument", "sendVoice", "sendVideo"].includes(
          operation,
        )
      ) {
        if (file.size > 50 << 20) throw new Error("Файл превышает 50 МиБ");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        data = btoa(binary);
      }
      const result = await api("bot", {
        operation,
        ...(data ? { file: { data, name: file!.name, mime: file!.type } } : {}),
      });
      complete(`bot:${operation}`, result);
    } catch (error) {
      complete(
        `bot:${operation}`,
        error instanceof Error ? error.message : "Ошибка бота",
        "failed",
      );
    }
  };
  const playAudio = async () => {
    try {
      audio.current ??= new AudioContext();
      await audio.current.resume();
      setAudioState(audio.current.state);
      if (audio.current.state !== "running") return;
      const oscillator = audio.current.createOscillator();
      const gain = audio.current.createGain();
      gain.gain.value = 0.08;
      oscillator.frequency.value = 440;
      oscillator.connect(gain);
      gain.connect(audio.current.destination);
      oscillator.start();
      oscillator.stop(audio.current.currentTime + 0.15);
      record("audio", "Контекст running; тестовый сигнал 150 мс");
    } catch {
      setAudioState("Заблокирован; повторите касанием");
    }
  };
  const exportReport = async () => {
    if (exporting) return;
    const report = {
      createdAt: new Date().toISOString(),
      appVersion,
      sdkBuild,
      bridgeCoverage: automatedRun ? bridgeCoverage(automatedRun) : [],
      adapter: client?.adapter.id ?? null,
      capabilities: [...(client?.adapter.capabilities ?? [])],
      automatedRun: automatedRun
        ? { ...automatedRun, summary: summarize(automatedRun) }
        : null,
      results,
      events: eventValues,
      log,
    };
    if (client?.supports("downloadFile")) {
      if (!authenticated) {
        setExportMessage(
          "Подпись не проверена; отчёт доступен для копирования.",
        );
        setReportText(JSON.stringify(report, null, 2));
        return;
      }
      setExporting(true);
      setExportMessage("Открываем сохранение отчёта…");
      try {
        const { path } = await api<{ path: string }>("report", { report });
        const accepted = await client.call("downloadFile", {
          url: new URL(path, location.origin).href,
          fileName: "lo-sdk-test-report.json",
        });
        setExportMessage(
          accepted
            ? "Отчёт передан LO для сохранения."
            : "Сохранение отменено.",
        );
        if (!accepted) setReportText(JSON.stringify(report, null, 2));
      } catch (error) {
        setExportMessage(
          `LO не подтвердил сохранение${error instanceof Error ? ` (${error.message})` : ""}. JSON доступен для копирования.`,
        );
        setReportText(JSON.stringify(report, null, 2));
      } finally {
        setExporting(false);
      }
      return;
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "lo-sdk-test-report.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const stateLabel = {
    running: "В процессе",
    done: "Вызов выполнен",
    denied: "Не выполнено",
    failed: "Ошибка",
  };
  const resultView = (name: string) =>
    results[name] ? (
      <Surface
        padding={3}
        className={`result ${results[name].state}`}
        role="status"
      >
        <Text as="strong" weight="bold" size="label">
          {stateLabel[results[name].state]}
        </Text>
        {results[name].detail && (
          <Text as="pre" family="mono" size="caption">
            {results[name].detail}
          </Text>
        )}
      </Surface>
    ) : null;
  const completed = Object.values(results).filter(
    (value) => value.state === "done",
  ).length;
  const failed = Object.values(results).filter(
    (value) => value.state === "failed",
  ).length;
  const groups = ["Все", "Экран", "Разрешения", "Датчики", "Хранилища"];
  const matchesGroup = (name: string) =>
    group === "Все" ||
    (group === "Хранилища"
      ? /Storage/.test(name)
      : group === "Датчики"
        ? /Accelerometer|Gyroscope|DeviceOrientation/.test(name)
        : group === "Разрешения"
          ? /Biometry|Location|Clipboard|Contact|WriteAccess|Qr/.test(name)
          : !/Storage|Accelerometer|Gyroscope|DeviceOrientation|Biometry|Location|Clipboard|Contact|WriteAccess|Qr/.test(
              name,
            ));
  return (
    <div className="app">
      <header>
        <Heading level={1}>LO SDK Test</Heading>
        <Text as="span" size="caption" className="connection" role="status">
          {client ? "LO подключён" : "Откройте в LO для живых проверок"}
        </Text>
      </header>
      <nav className="sdk-sections" aria-label="Разделы">
        <Button
          variant={tab === "Все проверки" ? "secondary" : "quiet"}
          size="small"
          aria-current={tab === "Все проверки" ? "page" : undefined}
          onClick={() => setTab("Все проверки")}
        >
          Проверка
        </Button>
        <Button
          variant={
            tab !== "Все проверки" && tab !== "UI" ? "secondary" : "quiet"
          }
          size="small"
          disabled={runningAll}
          aria-current={
            tab !== "Все проверки" && tab !== "UI" ? "page" : undefined
          }
          onClick={() => setTab("Приложение LO")}
        >
          Вручную
        </Button>
        <Button
          variant={tab === "UI" ? "secondary" : "quiet"}
          size="small"
          disabled={runningAll}
          aria-current={tab === "UI" ? "page" : undefined}
          onClick={() => setTab("UI")}
        >
          UI
        </Button>
      </nav>
      {tab !== "Все проверки" && tab !== "UI" && (
        <div
          className="manual-section"
          role="group"
          aria-label="Ручные проверки"
        >
          {[
            "Приложение LO",
            "Бот",
            "Секретарь",
            "Данные запуска",
            "Журнал",
          ].map((name) => (
            <Button
              key={name}
              variant={tab === name ? "primary" : "secondary"}
              aria-pressed={tab === name}
              onClick={() => setTab(name)}
            >
              {name}
            </Button>
          ))}
        </div>
      )}
      {exportMessage && (
        <Text
          tone="secondary"
          size="label"
          className="export-message"
          role="status"
        >
          {exportMessage}
        </Text>
      )}
      <main>
        {tab === "UI" && <UiPage />}
        {tab === "Секретарь" && (
          <SecretaryPage authenticated={authenticated} request={api} />
        )}
        {tab === "Все проверки" && (
          <RunPage
            report={automatedRun}
            interaction={interaction}
            starting={startingRun}
            stopping={stoppingRun}
            exporting={exporting}
            onStart={() => void startAll()}
            onResume={() => void startAll(true)}
            resuming={resumingRun}
            onStop={() => {
              setStoppingRun(Boolean(runController.current));
              runController.current?.abort();
              interactionController.current?.abort();
            }}
            onExport={() => void exportReport()}
            onDeferred={runDeferred}
          />
        )}
        {tab === "Данные запуска" && (
          <>
            <div className="section-heading">
              <Stack gap={1}>
                <Heading level={2}>Данные запуска</Heading>
                <Text tone="secondary" size="label"></Text>
              </Stack>
            </div>
            <Surface padding={0} className="group">
              <dl>
                <div>
                  <dt>Пользователь</dt>
                  <dd>{launch?.user?.firstName ?? "Нет данных"}</dd>
                </div>
                <div>
                  <dt>ID пользователя</dt>
                  <dd className="mono">{launch?.user?.id ?? "—"}</dd>
                </div>
                <div>
                  <dt>Язык из LO</dt>
                  <dd>{launch?.user?.languageCode || "Не передан"}</dd>
                </div>
                <div>
                  <dt>Параметр запуска</dt>
                  <dd>{launch?.startParam || "—"}</dd>
                </div>
                <div>
                  <dt>Подпись на сервере</dt>
                  <dd>{authenticated ? "Проверена" : "Не проверена"}</dd>
                </div>
              </dl>
              <div className="group-footer">
                <Text tone="secondary" size="caption">
                  Сырая строка и ключи не входят в отчёт.
                </Text>
                <Button
                  disabled={!client || !configuration?.appConfigured}
                  onClick={() => {
                    void authenticate();
                  }}
                >
                  Проверить подпись
                </Button>
                {!configuration?.appConfigured && (
                  <Text tone="secondary" size="caption">
                    Настройте ключ приложения на сервере, затем обновите
                    страницу.
                  </Text>
                )}
                {resultView("verifyInitData")}
              </div>
            </Surface>
            <Heading level={2} className="standalone-heading">
              Экран и звук
            </Heading>
            <Surface padding={0} className="group">
              <div className="row">
                <Stack gap={1}>
                  <Heading level={3}>Безопасные поля экрана</Heading>
                  <Text tone="secondary" size="label" family="mono">
                    {insets}
                  </Text>
                </Stack>
                <Button
                  variant="secondary"
                  disabled={!client}
                  onClick={() =>
                    complete("snapshot", client?.adapter.snapshot())
                  }
                >
                  Снимок
                </Button>
              </div>
              {resultView("snapshot")}
              <div className="row">
                <Stack gap={1}>
                  <Heading level={3}>Тестовый сигнал</Heading>
                  <Text tone="secondary" size="label">
                    Контекст: {audioState}
                  </Text>
                </Stack>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void playAudio();
                  }}
                >
                  Проверить звук
                </Button>
              </div>
            </Surface>
            <Heading level={2} className="standalone-heading">
              Результат текущего запуска
            </Heading>
            <Surface padding={0} className="group summary">
              <Text as="span" size="caption">
                <Text as="strong" weight="bold" size="title">
                  {completed}
                </Text>{" "}
                выполнено
              </Text>
              <Text as="span" size="caption">
                <Text as="strong" weight="bold" size="title">
                  {failed}
                </Text>{" "}
                ошибок
              </Text>
              <Text as="span" size="caption">
                <Text as="strong" weight="bold" size="title">
                  {operationNames.length}
                </Text>{" "}
                операций приложения LO в каталоге
              </Text>
            </Surface>
          </>
        )}
        {tab === "Приложение LO" && (
          <>
            <div className="section-heading">
              <Stack gap={1}>
                <Heading level={2}>Приложение LO</Heading>
                <Text tone="secondary" size="label">
                  Запускайте каждую проверку вручную. Доступность определяет LO.
                </Text>
              </Stack>
            </div>
            <TextField
              className="search"
              labelHidden
              label="Найти проверку"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Поиск по названию или методу"
            />
            <div className="filters" aria-label="Категория">
              {groups.map((name) => (
                <Button
                  key={name}
                  variant={group === name ? "primary" : "secondary"}
                  aria-pressed={group === name}
                  onClick={() => setGroup(name)}
                >
                  {name}
                </Button>
              ))}
            </div>
            <Surface padding={0} className="group operations">
              {operationNames
                .filter(
                  (name) =>
                    matchesGroup(name) &&
                    `${name} ${cases[name].label}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                )
                .map((name) => {
                  const definition = cases[name];
                  const supported =
                    client?.supports(definition.capability) ?? false;
                  const running = results[name]?.state === "running";
                  return (
                    <article key={name}>
                      <div className="row">
                        <Stack gap={1}>
                          <Heading level={3}>{definition.label}</Heading>
                          <Text tone="secondary" size="label">
                            <Text as="code" family="mono" size="caption">
                              {name}
                            </Text>{" "}
                            ·{" "}
                            {supported
                              ? "Доступно"
                              : "Приложение LO не поддерживает"}
                          </Text>
                        </Stack>
                        <div className="actions">
                          <Button
                            variant="secondary"
                            size="small"
                            aria-label={`Параметры ${definition.label}`}
                            onClick={() => {
                              setSelected(name);
                              setInput(
                                definition.input === undefined
                                  ? ""
                                  : JSON.stringify(definition.input, null, 2),
                              );
                            }}
                          >
                            Параметры
                          </Button>
                          {running ? (
                            <Button
                              variant="secondary"
                              onClick={() =>
                                controllers.current.get(name)?.abort()
                              }
                            >
                              Отмена
                            </Button>
                          ) : (
                            <Button
                              disabled={!supported}
                              onClick={() => {
                                void run(name);
                              }}
                            >
                              Тест
                            </Button>
                          )}
                        </div>
                      </div>
                      {resultView(name)}
                    </article>
                  );
                })}
              {operationNames.filter(
                (name) =>
                  matchesGroup(name) &&
                  `${name} ${cases[name].label}`
                    .toLowerCase()
                    .includes(filter.toLowerCase()),
              ).length === 0 && (
                <Text tone="secondary" size="label" className="empty">
                  Проверки не найдены. Измените поиск.
                </Text>
              )}
            </Surface>
            <Heading level={2} className="standalone-heading">
              События
            </Heading>
            <Surface padding={0} className="group event-list">
              {events.map((event) => (
                <div className="event" key={event}>
                  <Text as="code" family="mono" size="caption">
                    {event}
                  </Text>
                  <Text as="span" size="caption">
                    {eventValues[event] ?? "Пока не получено"}
                  </Text>
                </div>
              ))}
            </Surface>
          </>
        )}
        {tab === "Бот" && (
          <>
            <div className="section-heading">
              <Stack gap={1}>
                <Heading level={2}>Сообщения и медиа</Heading>
                <Text tone="secondary" size="label">
                  Тесты отправляются только вам, по проверенному ID.
                </Text>
              </Stack>
            </div>
            <Surface padding={0} className="group">
              <div className="row">
                <Stack gap={1}>
                  <Heading level={3}>Согласие на сообщения</Heading>
                  <Text tone="secondary" size="label">
                    {consent === true
                      ? "Разрешено"
                      : consent === false
                        ? "Отправка не разрешена"
                        : "Ещё не запрашивали"}
                  </Text>
                </Stack>
                <Button
                  disabled={
                    !authenticated ||
                    !configuration?.botConfigured ||
                    consent === true
                  }
                  onClick={() => {
                    void run("requestWriteAccess");
                  }}
                >
                  Разрешить
                </Button>
              </div>
              <div className="group-footer">
                <Text tone="secondary" size="caption">
                  {authenticated
                    ? "Подпись проверена"
                    : "Подпись запуска не проверена"}
                  .{" "}
                  {configuration?.botConfigured
                    ? "Токен бота настроен"
                    : "Токен бота ещё не настроен"}
                  .
                </Text>
                {backendMessage && (
                  <Text tone="secondary" size="label" role="status">
                    {backendMessage}
                  </Text>
                )}
                {consent !== null && (
                  <Button
                    variant="secondary"
                    disabled={!authenticated}
                    onClick={() => {
                      void saveConsent();
                    }}
                  >
                    Повторить отправку ответа
                  </Button>
                )}
                {resultView("requestWriteAccess")}
              </div>
            </Surface>
            <Surface padding={0} className="group bot-tests">
              {[
                "getIdentity",
                "getCapabilities",
                "getFile",
                "downloadFile",
                "getUpdates",
                "sendMessage",
                "editMessage",
                "deleteMessage",
                "setChatMenuButton",
                "getCommands",
                "setCommands",
              ].map((operation) => (
                <article key={operation}>
                  <div className="row">
                    <Text as="code" family="mono" size="caption">
                      {operation}
                    </Text>
                    <Button
                      disabled={
                        !authenticated ||
                        !configuration?.botConfigured ||
                        ([
                          "getUpdates",
                          "sendMessage",
                          "editMessage",
                          "deleteMessage",
                        ].includes(operation) &&
                          consent !== true)
                      }
                      onClick={() => {
                        void bot(operation);
                      }}
                    >
                      Тест
                    </Button>
                  </div>
                  {resultView(`bot:${operation}`)}
                </article>
              ))}
              <div className="group-footer">
                <TextField
                  label="Фото, документ, AAC-голосовое или MP4-видео"
                  type="file"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                <div
                  className="sample-files"
                  aria-label="Готовые файлы для проверки"
                >
                  <Button
                    variant="secondary"
                    onClick={() => void selectSample("photo")}
                  >
                    Тестовое фото
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void selectSample("document")}
                  >
                    Тестовый документ
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void selectSample("voice")}
                  >
                    Тестовое AAC
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void selectSample("video")}
                  >
                    Тестовое видео
                  </Button>
                </div>
                {file && (
                  <Text tone="secondary" size="caption">
                    Выбран: {file.name}
                  </Text>
                )}
                <Text tone="secondary" size="caption">
                  Голос: AAC в M4A/MP4 или сырой AAC. После загрузки можно
                  повторить по сохранённому fileId.
                </Text>
              </div>
              {[
                "sendPhoto",
                "sendDocument",
                "sendVoice",
                "sendVideo",
                "reusePhoto",
                "reuseDocument",
                "reuseVoice",
                "reuseVideo",
                "photoAlbum",
                "documentAlbum",
              ].map((operation) => (
                <article key={operation}>
                  <div className="row">
                    <Text as="code" family="mono" size="caption">
                      {operation}
                    </Text>
                    <Button
                      disabled={
                        !authenticated ||
                        !configuration?.botConfigured ||
                        consent !== true ||
                        (operation.startsWith("send") && !file)
                      }
                      onClick={() => {
                        void bot(operation);
                      }}
                    >
                      Тест
                    </Button>
                  </div>
                  {resultView(`bot:${operation}`)}
                </article>
              ))}
            </Surface>
            <Heading level={2} className="standalone-heading">
              Проверки отказов без отправки
            </Heading>
            <Surface padding={0} className="group">
              <div className="row">
                <Stack gap={1}>
                  <Heading level={3}>Ошибки и лимиты</Heading>
                  <Text tone="secondary" size="label">
                    400 / 403 / 429 / 503, URL вместо файла, HTTP-кнопка,
                    большая подпись
                  </Text>
                </Stack>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void bot("conformance");
                  }}
                >
                  Проверить
                </Button>
              </div>
              {resultView("bot:conformance")}
            </Surface>
          </>
        )}
        {tab === "Журнал" && (
          <>
            <div className="section-heading">
              <Stack gap={1}>
                <Heading level={2}>Журнал текущего запуска</Heading>
                <Text tone="secondary" size="label">
                  Последние 100 действий и событий. Ключи и строка запуска
                  скрыты.
                </Text>
              </Stack>
              <Button
                variant="secondary"
                size="small"
                onClick={() => setLog([])}
              >
                Очистить
              </Button>
            </div>
            <Surface padding={0} className="group">
              {log.length === 0 ? (
                <Text tone="secondary" size="label" className="empty">
                  Проверки ещё не запускались.
                </Text>
              ) : (
                log.map((entry, index) => (
                  <article className="log-entry" key={`${entry.time}-${index}`}>
                    <time>{entry.time}</time>
                    <div>
                      <Text as="code" family="mono" size="caption">
                        {entry.label}
                      </Text>
                      <Text as="pre" family="mono" size="caption">
                        {entry.detail}
                      </Text>
                    </div>
                  </article>
                ))
              )}
            </Surface>
          </>
        )}
      </main>
      {pendingAction && (
        <ActionConfirmation
          title={cases[pendingAction.name].label}
          detail={pendingAction.caution}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            const { name, supplied } = pendingAction;
            setPendingAction(null);
            void run(name, supplied, true);
          }}
        />
      )}
      {reportText && (
        <Dialog
          ref={reportDialog}
          className="modal"
          aria-labelledby="report-title"
          onCancel={() => setReportText("")}
        >
          <Stack gap={4}>
            <Heading level={2} id="report-title">
              Отчёт проверки
            </Heading>
            <Text tone="secondary" size="label">
              Скопируйте JSON отчёта.
            </Text>
            <TextArea
              label="JSON отчёта"
              readOnly
              rows={12}
              value={reportText}
            />
            <div className="actions">
              <Button
                variant="secondary"
                onClick={() => {
                  reportDialog.current?.close();
                  setReportText("");
                }}
              >
                Закрыть
              </Button>
            </div>
          </Stack>
        </Dialog>
      )}
      {selected && (
        <Dialog
          ref={dialog}
          className="modal"
          aria-labelledby="editor-title"
          onCancel={() => setSelected(null)}
        >
          <Stack gap={4}>
            <Heading level={2} id="editor-title">
              {cases[selected].label}
            </Heading>
            <Text tone="secondary" size="label">
              <Text as="code" family="mono" size="caption">
                {selected}
              </Text>
            </Text>
            <TextArea
              label="Параметры JSON; пусто для вызова без параметров"
              id="params"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              autoFocus
              rows={8}
            />
            <div className="actions">
              <Button variant="secondary" onClick={() => setSelected(null)}>
                Закрыть
              </Button>
              <Button
                disabled={!client?.supports(cases[selected].capability)}
                onClick={() => {
                  try {
                    const parsed = input ? JSON.parse(input) : undefined;
                    const name = selected;
                    setSelected(null);
                    void run(name, parsed);
                  } catch {
                    complete(selected, "Некорректный JSON", "failed");
                  }
                }}
              >
                Запустить
              </Button>
            </div>
          </Stack>
        </Dialog>
      )}
    </div>
  );
}
