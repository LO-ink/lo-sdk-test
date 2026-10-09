import {
  attributionSummary,
  exportContext,
  normalizeProvenance,
} from "./provenance.ts";
import {
  Button,
  Tabs,
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
import { api, uploadFile } from "./api.ts";
import { applyPalette, type ThemePreference } from "./theme.ts";
import { SecretaryPage } from "./SecretaryPage.tsx";
import { UiPage } from "./UiPage.tsx";
import { LaunchDetails } from "./LaunchDetails.tsx";
import { useTabSwipe } from "./use-tab-swipe.ts";
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
import { orderRunPlan } from "./run-plan.ts";
import { createSuite } from "./suite.ts";
import { beginWriteAccess, type WriteAccessResult } from "./consent.ts";
import sdkBuild from "../sdk-build.json";
import { version as appVersion } from "../package.json";
import { beginAudio, type AudioStart } from "./audio.ts";
import { createInteraction, type InteractionView } from "./interaction.ts";
import { availableBridges } from "./bridges.ts";
import { createRunPersistence, persistenceUnavailable } from "./persistence.ts";
import { systemThemeChecks } from "./system-theme.ts";
import { ActionConfirmation } from "./ActionConfirmation.tsx";
import {
  applyDeferredResult,
  canRunDeferred,
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

import {
  attestManualCleanup,
  isManuallyRetired,
  lastRunKey,
} from "./manual-recovery.ts";
import {
  readArchivedHistory,
  oldestOwnedArchive,
  retireHistory,
  type HistoricalReport,
  readHistorical,
  historicalExport,
  preserveHistory,
  assertHistoryArchived,
  assertHistoryOwner,
} from "./history.ts";
import { recoverRun, recoveryPending } from "./recovery.ts";
import {
  dependencyKey,
  readRun,
  readRecovery,
  saveRun,
  sameOwner,
  type RecoveryTicket,
} from "./run-storage.ts";
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
export function App() {
  const [client, setClient] = useState<MiniAppClient | null>(null);
  const clientRef = useRef(client);
  clientRef.current = client;
  const [persistence] = useState(() => createRunPersistence());
  const storage = persistence.storage;
  const [persistenceFailed, setPersistenceFailed] = useState(
    persistence.unavailable,
  );
  const [tab, setTab] = useState("Все проверки");
  const [themePreference, setThemePreference] =
    useState<ThemePreference>("host");
  const themePreferenceRef = useRef(themePreference);
  themePreferenceRef.current = themePreference;
  const explicitThemeChange = useRef(false);
  const refreshAppearance = useRef<(() => void) | null>(null);
  useEffect(() => {
    refreshAppearance.current?.();
  }, [themePreference]);
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
  const [inputError, setInputError] = useState("");
  const [eventValues, setEventValues] = useState<Record<string, string>>({});
  const [insets, setInsets] = useState("Нет данных LO");
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [reportText, setReportText] = useState("");
  const controllers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const audio = useRef<AudioContext | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const parameterInput = useRef<HTMLTextAreaElement>(null);
  const reportDialog = useRef<HTMLDialogElement>(null);
  const [mountedSnapshot] = useState(() => {
    try {
      return storage.getItem(lastRunKey);
    } catch {
      return null;
    }
  });
  const expectedSnapshot = useRef(mountedSnapshot);
  const initialStorage = {
    getItem: (key: string) =>
      key === lastRunKey ? mountedSnapshot : storage.getItem(key),
    setItem: storage.setItem,
  };
  const [automatedRun, setAutomatedRun] = useState<RunReport | null>(() =>
    readRun(initialStorage, dependencies),
  );
  const [pendingRecovery, setPendingRecovery] = useState<RecoveryTicket | null>(
    () => readRecovery(initialStorage, dependencies),
  );
  const [history, setHistory] = useState(() => {
    try {
      return (
        readHistorical(initialStorage, dependencies) ??
        readArchivedHistory(storage, dependencies)
      );
    } catch {
      return null;
    }
  });
  const historicalAtMount = useRef(
    Boolean(history && history.snapshot === mountedSnapshot),
  );
  const historyBusy = useRef(false);
  const [archiveExport, setArchiveExport] = useState<HistoricalReport | null>(
    null,
  );
  const [retireConfirmation, setRetireConfirmation] = useState(false);
  const [historyWorking, setHistoryWorking] = useState(false);
  const historyArchived = useRef(
    Boolean(history && history.snapshot !== mountedSnapshot),
  );
  const preservingHistory = useRef(false);
  const verifyHistoryIdentity = async () => {
    const target = clientRef.current;
    const owner = target ? deferredIdentity(target) : null;
    if (!owner?.appId || !owner.userId)
      throw new Error("Откройте отчёт из прежнего аккаунта в LO.");
    const raw = target?.adapter.launchData;
    if (!raw) throw new Error("Откройте отчёт из прежнего аккаунта в LO.");
    const verified = await api<{
      verified: boolean;
      appId: string;
      userId: string;
    }>("verify-launch", { raw });
    const live = createLoClient();
    try {
      if (
        live?.adapter.launchData !== raw ||
        !sameOwner(
          { owner },
          live ? (deferredIdentity(live) ?? undefined) : undefined,
        )
      )
        throw new Error(
          "Аккаунт или приложение LO изменились. Откройте отчёт заново.",
        );
    } finally {
      live?.dispose();
    }
    if (
      !mounted.current ||
      target !== clientRef.current ||
      target.adapter.launchData !== raw ||
      !sameOwner({ owner: owner! }, deferredIdentity(target) ?? undefined) ||
      verified.verified !== true ||
      verified.appId !== owner!.appId ||
      verified.userId !== owner!.userId
    )
      throw new Error(
        "Не удалось подтвердить прежний аккаунт и приложение LO.",
      );
    if (storage.getItem(lastRunKey) !== expectedSnapshot.current)
      throw new Error(
        "Сохранённый прогон изменился. Откройте приложение заново.",
      );
    return owner;
  };
  const verifyHistory = async () => {
    if (!history) throw new Error("Прежний отчёт недоступен");
    assertHistoryOwner(
      history,
      clientRef.current
        ? (deferredIdentity(clientRef.current) ?? undefined)
        : undefined,
    );
    const owner = await verifyHistoryIdentity();
    assertHistoryOwner(history, owner);
    if (historyArchived.current) assertHistoryArchived(storage, history);
    else if (expectedSnapshot.current !== history.snapshot)
      throw new Error("Прежний отчёт изменился");
    return owner;
  };
  const exportArchiveForRetirement = async () => {
    if (historyBusy.current || runController.current) return;
    historyBusy.current = true;
    setHistoryWorking(true);
    try {
      const owner = await verifyHistoryIdentity();
      const archived = oldestOwnedArchive(storage, dependencies, owner);
      if (!archived)
        throw new Error(
          "Нет доступных архивных копий для удаления. Прежний отчёт будет сохранён в архиве при новом запуске. Если здесь есть копии другого аккаунта, откройте его в LO.",
        );
      setArchiveExport(archived);
      setReportText(historicalExport(archived, owner));
    } catch (error) {
      setExportMessage(
        error instanceof Error ? error.message : "Архив недоступен",
      );
    } finally {
      historyBusy.current = false;
      setHistoryWorking(false);
    }
  };
  const finishArchiveRetirement = async () => {
    setRetireConfirmation(false);
    if (!archiveExport || historyBusy.current || runController.current) return;
    historyBusy.current = true;
    setHistoryWorking(true);
    try {
      const owner = await verifyHistoryIdentity();
      retireHistory(
        storage,
        archiveExport,
        owner,
        expectedSnapshot.current,
        true,
      );
      if (history?.snapshot === archiveExport.snapshot) {
        if (expectedSnapshot.current === history.snapshot)
          historyArchived.current = false;
        else {
          setHistory(readArchivedHistory(storage, dependencies));
          historyArchived.current = true;
        }
      }
      setArchiveExport(null);
      setExportMessage(
        "Архивная копия удалена по вашему подтверждению. Текущий прогон и результаты проверок не изменены.",
      );
    } catch (error) {
      setExportMessage(
        error instanceof Error
          ? error.message
          : "Не удалось удалить архивную копию",
      );
    } finally {
      historyBusy.current = false;
      setHistoryWorking(false);
    }
  };
  const exportHistory = async () => {
    if (!history || historyBusy.current || runController.current) return;
    historyBusy.current = true;
    setHistoryWorking(true);
    try {
      const owner = await verifyHistory();
      setArchiveExport(null);
      setReportText(historicalExport(history, owner));
    } catch (error) {
      setExportMessage(
        error instanceof Error ? error.message : "Прежний отчёт недоступен",
      );
    } finally {
      historyBusy.current = false;
      setHistoryWorking(false);
    }
  };
  const pendingRecoveryRef = useRef(pendingRecovery);
  pendingRecoveryRef.current = pendingRecovery;
  const [retiredAtMount] = useState(() => {
    try {
      return mountedSnapshot && isManuallyRetired(storage, mountedSnapshot)
        ? mountedSnapshot
        : null;
    } catch {
      return null;
    }
  });
  const retiredRecovery = useRef<string | null>(retiredAtMount);
  const [recovering, setRecovering] = useState(false);
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
  useEffect(
    () =>
      persistence.subscribe(() => {
        setPersistenceFailed(true);
        runController.current?.abort(new Error(persistenceUnavailable));
        interactionController.current?.abort(new Error(persistenceUnavailable));
      }),
    [persistence],
  );
  const finishDeferred = (
    ticket: DeferredTicket,
    result: Parameters<typeof applyDeferredResult>[2],
  ) => {
    if (!mounted.current) return;
    try {
      if (storage.getItem(lastRunKey) !== expectedSnapshot.current)
        throw new Error("Сохранённый прогон изменился");
      const report = persistDeferredResult(
        storage,
        automatedRunRef.current,
        ticket,
        result,
        appVersion,
        dependencies,
        clientRef.current ? deferredIdentity(clientRef.current) : null,
      );
      if (report !== automatedRunRef.current) {
        expectedSnapshot.current = JSON.stringify({
          schema: 1,
          appVersion,
          dependencies,
          report,
        });
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
    if (!client || persistence.unavailable) return;
    const identity = deferredIdentity(client);
    if (!identity) return;
    const ticket = readDeferredTicket(
      storage,
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
    if (persistence.unavailable) return;
    if (
      !automatedRun ||
      runController.current ||
      deferredBusy.current ||
      interaction
    )
      return;
    try {
      if (storage.getItem(lastRunKey) !== expectedSnapshot.current)
        throw new Error(
          "Сохранённый прогон изменился. Откройте приложение заново перед завершающей проверкой.",
        );
    } catch (error) {
      setExportMessage(
        error instanceof Error ? error.message : persistenceUnavailable,
      );
      return;
    }
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
    if (!canRunDeferred(automatedRun, id, identity)) {
      dispose();
      setExportMessage(
        "Нужен завершённый прогон текущего пользователя с успешным восстановлением состояния.",
      );
      return;
    }
    // A repeat of a pending sendData checks its original nonce, never resends it.
    const pending = readDeferredTicket(
      storage,
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
      if (storage.getItem(lastRunKey) !== expectedSnapshot.current)
        throw new Error("Сохранённый прогон изменился");
      expectedSnapshot.current = saveRun(
        storage,
        automatedRun,
        appVersion,
        dependencies,
      );
      if (storage.getItem(lastRunKey) !== expectedSnapshot.current)
        throw new Error("Сохранённый прогон изменился");
      storage.setItem(deferredKey, JSON.stringify(ticket));
      if (storage.getItem(lastRunKey) !== expectedSnapshot.current)
        throw new Error("Сохранённый прогон изменился");
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
          ownsDeferredTicket(storage, ticket)
        ) {
          setDeferredRevision((value) => value + 1);
        }
      })
      .catch((error) => {
        if (!ownsDeferredTicket(storage, ticket)) return;
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
  const runningAll =
    recovering || startingRun || automatedRun?.state === "running";
  const manualTab = useRef("Приложение LO");
  const section =
    tab === "Все проверки" ? "checks" : tab === "UI" ? "ui" : "manual";
  const selectSection = (value: string) => {
    if (runningAll) return;
    setTab(
      value === "checks"
        ? "Все проверки"
        : value === "ui"
          ? "UI"
          : manualTab.current,
    );
  };
  const swipe = useTabSwipe({
    value: section,
    values: ["checks", "manual", "ui"],
    disabled: runningAll,
    onChange: selectSection,
  });
  const restorePrevious = async () => {
    if (persistence.unavailable) return;
    const ticket = pendingRecoveryRef.current;
    if (
      !ticket ||
      runController.current ||
      deferredBusy.current ||
      interaction ||
      controllers.current.size
    )
      return;
    const controller = new AbortController();
    runController.current = controller;
    setRecovering(true);
    setExportMessage("");
    const bridges = availableBridges();
    try {
      const remaining = await recoverRun(
        ticket,
        bridges,
        storage,
        controller.signal,
        (update) => {
          expectedSnapshot.current = update.snapshot;
          pendingRecoveryRef.current = update;
          if (mounted.current) setPendingRecovery(update);
        },
      );
      if (!recoveryPending(remaining)) {
        pendingRecoveryRef.current = null;
        if (mounted.current) {
          setPendingRecovery(null);
          setExportMessage(
            "Прежние тестовые данные удалены, состояние восстановлено. Запустите новую проверку текущих SDK.",
          );
        }
      }
    } catch (error) {
      if (mounted.current)
        setExportMessage(
          error instanceof Error
            ? error.message
            : "Не удалось завершить восстановление",
        );
    } finally {
      for (const bridge of bridges) bridge.client?.dispose();
      runController.current = null;
      if (mounted.current) setRecovering(false);
    }
  };
  const finishManualCleanup = () => {
    if (
      persistence.unavailable ||
      runController.current ||
      interaction ||
      controllers.current.size
    )
      return;
    const ticket = pendingRecoveryRef.current;
    if (!ticket) return;
    try {
      attestManualCleanup(storage, ticket, true);
      retiredRecovery.current = ticket.snapshot;
      pendingRecoveryRef.current = null;
      setPendingRecovery(null);
      automatedRunRef.current = null;
      setAutomatedRun(null);
      setExportMessage(
        "Ручная очистка подтверждена вами, SDK её не проверял. Исходная запись сохранена в локальном архиве. Теперь можно запустить новую проверку.",
      );
    } catch (error) {
      setExportMessage(
        error instanceof Error
          ? error.message
          : "Не удалось сохранить подтверждение. Обязательства очистки сохранены.",
      );
    }
  };
  const startAll = async (resume = false) => {
    if (persistence.unavailable || historyBusy.current) return;
    if (
      runController.current ||
      deferredBusy.current ||
      interaction ||
      controllers.current.size ||
      Object.values(results).some((r) => r.state === "running")
    )
      return;
    if (pendingRecoveryRef.current) {
      setExportMessage(
        "Сначала восстановите состояние прежнего прогона. Его результаты не относятся к текущим SDK.",
      );
      return;
    }
    if (!resume && hasRecoveryDebt(automatedRunRef.current)) {
      setExportMessage(
        "Сначала восстановите состояние прежнего прогона кнопкой продолжения. Новый запуск не должен потерять незавершённую очистку.",
      );
      return;
    }
    try {
      const snapshot = storage.getItem(lastRunKey);
      if (snapshot !== expectedSnapshot.current)
        throw new Error(
          "Архив или сохранённый прогон изменился. Откройте приложение заново перед запуском.",
        );
      if (
        retiredRecovery.current &&
        (snapshot !== retiredRecovery.current ||
          !isManuallyRetired(storage, snapshot))
      )
        throw new Error(
          "Архив или сохранённый прогон изменился. Откройте приложение заново перед запуском.",
        );
      const outstanding = readRecovery(storage, dependencies);
      if (outstanding) {
        pendingRecoveryRef.current = outstanding;
        setPendingRecovery(outstanding);
        return;
      }
      if (persistence.unavailable) return;
    } catch (error) {
      setExportMessage(
        error instanceof Error ? error.message : persistenceUnavailable,
      );
      return;
    }
    const displacedHistory =
      !resume && history?.snapshot === expectedSnapshot.current
        ? history
        : null;
    if (displacedHistory) {
      try {
        if (!historyArchived.current) {
          preserveHistory(storage, displacedHistory);
          historyArchived.current = true;
        }
        assertHistoryArchived(storage, displacedHistory);
        preservingHistory.current = true;
      } catch (error) {
        setExportMessage(
          error instanceof Error
            ? error.message
            : "Не удалось сохранить прежний отчёт",
        );
        return;
      }
    }
    const previous = resume ? automatedRunRef.current : null;
    if (resume && !canResume(previous)) return;
    const bridges = availableBridges();
    const primary = bridges[0];
    const runClient = primary.client;
    const runOwner = runClient
      ? (deferredIdentity(runClient) ?? undefined)
      : undefined;
    if (previous && !sameOwner(previous, runOwner)) {
      for (const bridge of bridges) bridge.client?.dispose();
      setExportMessage(
        "Этот прогон относится к другому пользователю или приложению. Откройте его в прежнем аккаунте LO либо начните новый.",
      );
      return;
    }
    try {
      storage.removeItem(deferredKey);
    } catch {
      for (const bridge of bridges) bridge.client?.dispose();
      setExportMessage(persistenceUnavailable);
      return;
    }
    const runId = previous?.id ?? crypto.randomUUID();
    const controller = new AbortController();
    runController.current = controller;
    setResumingRun(resume);
    setConsent(null);
    setExportMessage("");
    runEvents.current = {};
    let resolveAudio!: (value: AudioStart | PromiseLike<AudioStart>) => void;
    const audioStarted = new Promise<AudioStart>((resolve) => {
      resolveAudio = resolve;
    });
    setStartingRun(true);
    setStoppingRun(false);
    const interact = createInteraction((view) => {
      if (mounted.current) setInteraction(view);
    });
    const writeAccess = runClient?.supports("requestWriteAccess")
      ? async (signal: AbortSignal): Promise<WriteAccessResult> => {
          const answer = await interact(
            {
              title: "Разрешение на сообщения бота",
              detail:
                "Теперь начнутся проверки с вашим участием. Разрешите тестовому боту отправку сообщений и файлов.",
              actionLabel: "Запросить разрешение",
              action: () => beginWriteAccess(runClient, signal),
            },
            signal,
          );
          return answer.decision === "skip"
            ? { allowed: false, skipped: true }
            : (answer.value as WriteAccessResult);
        }
      : undefined;
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
      upload: uploadFile,
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
    const unsortedPlan: Check[] = [];
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
      automatedRunRef.current = report;
      if (mounted.current) setAutomatedRun(report);
      try {
        if (storage.getItem(lastRunKey) !== expectedSnapshot.current)
          throw new Error("Сохранённый прогон изменился");
        if (retiredRecovery.current) {
          const snapshot = retiredRecovery.current;
          if (
            storage.getItem(lastRunKey) !== snapshot ||
            !isManuallyRetired(storage, snapshot)
          )
            throw new Error("Архив ручной очистки изменился");
        }
        if (displacedHistory) assertHistoryArchived(storage, displacedHistory);
        expectedSnapshot.current = saveRun(
          storage,
          report,
          appVersion,
          dependencies,
        );
        retiredRecovery.current = null;
      } catch {
        controller.abort(new Error(persistenceUnavailable));
        const interrupted: RunReport = {
          ...report,
          state: "cancelled",
          resumeBlocked: true,
          resumeError: persistenceUnavailable,
          checks: report.checks.map((check) =>
            check.id === "cleanup"
              ? {
                  ...check,
                  state: "failed",
                  evidence: undefined,
                  detail: "Сохранение восстановления не подтверждено",
                }
              : check,
          ),
        };
        automatedRunRef.current = interrupted;
        if (mounted.current) setAutomatedRun(interrupted);
        throw new Error(persistenceUnavailable);
      }
      if (mounted.current) setStartingRun(false);
    };
    for (const bridge of bridges) {
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
        unsortedPlan.push({
          ...check,
          id: host || event ? `${bridge.id}:${check.id}` : check.id,
          bridge: host || event ? bridge.label : undefined,
          group:
            host || event ? `${bridge.label} · ${check.group}` : check.group,
        });
        if (bridge === primary && check.id === "audio-playback")
          unsortedPlan.push(...themes);
      }
      cleanups.push({
        ...suite.cleanup,
        id: `${bridge.id}:cleanup`,
        label: `${bridge.label}: восстановление`,
      });
    }
    if (includeBot) unsortedPlan.push(createDeliveryCheck(() => latestReport));
    const plan = orderRunPlan(unsortedPlan, previous?.checks);
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
      if (storage.getItem(lastRunKey) !== expectedSnapshot.current)
        throw new Error(
          "Сохранённый прогон изменился. Откройте приложение заново перед запуском.",
        );
      if (displacedHistory) assertHistoryArchived(storage, displacedHistory);
      try {
        audio.current ??= new AudioContext();
      } catch {
        // Preserve the normal unavailable result when Web Audio cannot start.
      }
      resolveAudio(beginAudio(audio.current));

      await runChecks(plan, cleanup, controller.signal, publishReport, 12000, {
        id: runId,
        ...(previous
          ? {
              previous,
              prepare: async (signal, record) => {
                for (const suite of suites.values())
                  await suite.prepareResume(signal, record);
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
      const preference = themePreferenceRef.current;
      const scheme =
        (preference === "host" ? snapshot?.colorScheme : preference) ??
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      document.documentElement.dataset.loTheme = scheme;
      const colors = preference === "host" ? snapshot?.theme : undefined;
      const hostColor = (value: string | undefined) =>
        value && /^#[a-f0-9]{6}$/i.test(value) ? value : undefined;
      applyPalette(document.documentElement, scheme, {
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
      if (
        testingAppearance.current ||
        pendingRecoveryRef.current ||
        (historicalAtMount.current &&
          !preservingHistory.current &&
          !explicitThemeChange.current)
      )
        return;
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
    refreshAppearance.current = appearance;
    appearance();
    if (!pendingRecoveryRef.current && !historicalAtMount.current) {
      try {
        audio.current = new AudioContext();
        void audio.current
          .resume()
          .then(() => {
            if (mounted.current)
              setAudioState(audio.current?.state ?? "closed");
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
      refreshAppearance.current = null;
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
      const result =
        file &&
        ["sendPhoto", "sendDocument", "sendVoice", "sendVideo"].includes(
          operation,
        )
          ? await uploadFile(operation, file)
          : await api("bot", { operation });
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
    if (exporting || pendingRecoveryRef.current) return;
    const report = {
      exportContext: exportContext(),
      executionAttribution: automatedRun
        ? attributionSummary(automatedRun)
        : null,
      bridgeCoverage: automatedRun ? bridgeCoverage(automatedRun) : [],
      adapter: client?.adapter.id ?? null,
      capabilities: [...(client?.adapter.capabilities ?? [])],
      automatedRun: automatedRun
        ? {
            ...normalizeProvenance(automatedRun),
            summary: summarize(automatedRun),
          }
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
      <Tabs
        id="sdk-sections"
        className="sdk-sections"
        aria-label="Разделы"
        value={section}
        onValueChange={selectSection}
        options={[
          { value: "checks", label: "Проверка", panelId: "sdk-panel" },
          {
            value: "manual",
            label: "Вручную",
            panelId: "sdk-panel",
            disabled: runningAll,
          },
          {
            value: "ui",
            label: "UI",
            panelId: "sdk-panel",
            disabled: runningAll,
          },
        ]}
      />
      {section === "manual" && (
        <Tabs
          className="manual-section"
          aria-label="Ручные проверки"
          value={tab}
          onValueChange={(name) => {
            manualTab.current = name;
            setTab(name);
          }}
          options={[
            "Приложение LO",
            "Бот",
            "Секретарь",
            "Данные запуска",
            "Журнал",
          ].map((name) => ({ value: name, label: name }))}
        />
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
      <main
        id="sdk-panel"
        role="tabpanel"
        aria-labelledby={`sdk-sections-tab-${["checks", "manual", "ui"].indexOf(section)}`}
        {...swipe}
      >
        {tab === "UI" && (
          <UiPage
            theme={themePreference}
            onThemeChange={(value) => {
              explicitThemeChange.current = true;
              setThemePreference(value);
            }}
          />
        )}
        {tab === "Секретарь" && (
          <SecretaryPage authenticated={authenticated} request={api} />
        )}
        {tab === "Все проверки" && (
          <Stack gap={4}>
            {history && !pendingRecovery && !runningAll && (
              <Surface padding={3} aria-label="Прежний отчёт">
                <Stack gap={2}>
                  <Text size="label">
                    {historyArchived.current
                      ? "Прежний отчёт в архиве"
                      : "Сохранён прежний отчёт"}
                  </Text>
                  <Text size="caption" tone="secondary">
                    {historyArchived.current ? (
                      "Он сохранён отдельно от текущего прогона и не может быть возобновлён."
                    ) : (
                      <>
                        {history.reason === "expired"
                          ? "Срок продолжения истёк."
                          : "Версии SDK или план проверки изменились."}{" "}
                        Продолжить прежнюю проверку нельзя. Новый запуск
                        сохранит её в локальном архиве.
                      </>
                    )}
                  </Text>
                  <Text size="caption" tone="secondary">
                    Для доступа нужен тот же аккаунт и приложение LO. Результаты
                    прежнего отчёта не подтверждают текущие SDK.
                  </Text>
                  <Button
                    variant="secondary"
                    disabled={historyWorking}
                    onClick={() => void exportHistory()}
                  >
                    {historyWorking
                      ? "Проверяем доступ…"
                      : "Сохранить прежний отчёт"}
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={historyWorking || persistenceFailed}
                    onClick={() => void exportArchiveForRetirement()}
                  >
                    Освободить место в архиве
                  </Button>
                </Stack>
              </Surface>
            )}
            <div>
              <RunPage
                report={automatedRun}
                persistenceUnavailable={persistenceFailed}
                pendingRecovery={pendingRecovery}
                recovering={recovering}
                onRecover={() => void restorePrevious()}
                onManualCleanup={finishManualCleanup}
                interaction={interaction}
                starting={startingRun}
                startBlocked={historyWorking}
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
                identity={client ? deferredIdentity(client) : null}
              />
            </div>
          </Stack>
        )}
        {tab === "Данные запуска" && (
          <>
            <div className="section-heading">
              <Stack gap={1}>
                <Heading level={2}>Данные запуска</Heading>
              </Stack>
            </div>
            <Surface padding={0} className="group">
              <LaunchDetails
                launch={launch}
                authenticated={authenticated}
                locale={client?.adapter.snapshot().locale}
                onOpenPhoto={
                  client?.supports("openLink")
                    ? (url) => void run("openLink", { url })
                    : undefined
                }
              />
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
                {resultView("openLink")}
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
              variant="search"
              label="Найти проверку"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Поиск по названию или методу"
            />
            <Tabs
              className="filters"
              aria-label="Группы проверок"
              value={group}
              onValueChange={setGroup}
              options={groups.map((value) => ({ value, label: value }))}
            />
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
                              setInputError("");
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
                              size="small"
                              onClick={() =>
                                controllers.current.get(name)?.abort()
                              }
                            >
                              Отмена
                            </Button>
                          ) : (
                            <Button
                              size="small"
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
      {retireConfirmation && (
        <ActionConfirmation
          title="Удалить архивную копию?"
          detail="Подтвердите, что вы сохранили JSON отчёта. Будет удалена только эта архивная копия вашего аккаунта; текущий прогон останется без изменений."
          onCancel={() => setRetireConfirmation(false)}
          onConfirm={() => void finishArchiveRetirement()}
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
              {archiveExport && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    reportDialog.current?.close();
                    setReportText("");
                    setRetireConfirmation(true);
                  }}
                >
                  Копия сохранена — удалить из архива
                </Button>
              )}
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
              ref={parameterInput}
              value={input}
              error={inputError || undefined}
              onChange={(event) => {
                setInput(event.target.value);
                setInputError("");
              }}
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
                    setInputError(
                      "Некорректный JSON. Исправьте параметры и повторите запуск.",
                    );
                    parameterInput.current?.focus();
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
