import { normalizeProvenance, recordExecution } from "./provenance.ts";
import { saveRun } from "./run-storage.ts";
import type { MiniAppClient } from "@lo-ink/miniapp-sdk";
import {
  hasRecoveryDebt,
  unfinished,
  type Check,
  type CheckResult,
  type RunReport,
} from "./runner.ts";

export const deferredKey = "sdk-test.end-action";
export { lastRunKey } from "./run-storage.ts";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type DeferredIdentity = { appId: string; userId: string };
export type DeferredTicket = DeferredIdentity & {
  schema: 1;
  appVersion: string;
  runId: string;
  id: string;
  bridgeId: "native" | "bot";
  operation: "close" | "sendData" | "delivery";
  attemptId: string;
  createdAt: number;
  data?: string;
};
const deliveryOperations = [
  "sendPhoto",
  "reusePhoto",
  "sendDocument",
  "reuseDocument",
  "sendVoice",
  "reuseVoice",
];
function deliverySendsPassed(report: RunReport | null): boolean {
  return deliveryOperations.every((operation) =>
    report?.checks.some(
      (check) => check.id === `bot:${operation}` && check.state === "passed",
    ),
  );
}
export function createDeliveryCheck(report: () => RunReport | null): Check {
  return {
    id: "bot:delivery",
    label: "Доставка файлов в чат",
    group: "Бот · устройство",
    execute: async () => ({
      state: "manual",
      detail: deliverySendsPassed(report())
        ? "Ответы API получены. Проверьте доставку кнопкой в готовом отчёте после восстановления; переходить в чат во время прогона не нужно."
        : "Не все отправки выполнены: проверьте ошибки и пропуски бота",
    }),
  };
}
export function canVerifyDelivery(report: RunReport | null): boolean {
  return canRunDeferred(report, "bot:delivery", report?.owner ?? null);
}
export function isDeferredCheck(id: string): boolean {
  return /^native:(close|sendData)$/.test(id) || id === "bot:delivery";
}
/** The same invariant gates UI actions, persisted attempts, and result commits. */
export function canRunDeferred(
  report: RunReport | null,
  id: string,
  identity: DeferredIdentity | null,
): boolean {
  return Boolean(
    report?.state === "finished" &&
    identity?.appId &&
    identity.userId &&
    report.owner?.appId === identity.appId &&
    report.owner?.userId === identity.userId &&
    !report.resumeBlocked &&
    !hasRecoveryDebt(report) &&
    !report.checks.some(unfinished) &&
    isDeferredCheck(id) &&
    (!report.assistedBridge ||
      id.startsWith("bot:") ||
      id.startsWith(`${report.assistedBridge}:`)) &&
    report.checks.some(
      (check) => check.id === "cleanup" && check.state === "passed",
    ) &&
    report.checks.some(
      (check) =>
        check.id === id && check.state === "manual" && !check.scopeExcluded,
    ) &&
    (id !== "bot:delivery" || deliverySendsPassed(report)),
  );
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function deferredIdentity(
  client: MiniAppClient,
): DeferredIdentity | null {
  const launch = client.launchUnsafe();
  return launch.appId && launch.user?.id
    ? { appId: String(launch.appId), userId: String(launch.user.id) }
    : null;
}
export function createDeferredTicket(
  report: RunReport,
  id: string,
  appVersion: string,
  identity: DeferredIdentity,
  now = Date.now(),
): DeferredTicket {
  const [bridgeId, operation, extra] = id.split(":");
  if (extra || !canRunDeferred(report, id, identity))
    throw new Error("Завершающая проверка недоступна");
  const attemptId = crypto.randomUUID();
  return {
    schema: 1,
    appVersion,
    runId: report.id,
    id,
    bridgeId: bridgeId as DeferredTicket["bridgeId"],
    operation: operation as DeferredTicket["operation"],
    attemptId,
    createdAt: now,
    ...identity,
    ...(operation === "sendData" ? { data: `lo-sdk-test:${attemptId}` } : {}),
  };
}
export function readDeferredTicket(
  storage: Storage,
  report: RunReport | null,
  appVersion: string,
  identity: DeferredIdentity,
  now = Date.now(),
): DeferredTicket | null {
  try {
    const value = JSON.parse(storage.getItem(deferredKey) ?? "null");
    if (
      !value ||
      value.schema !== 1 ||
      value.appVersion !== appVersion ||
      !report ||
      value.runId !== report.id ||
      value.appId !== identity.appId ||
      value.userId !== identity.userId ||
      !canRunDeferred(report, value.id, identity) ||
      value.id !== `${value.bridgeId}:${value.operation}` ||
      !report.checks.some(
        (check) => check.id === value.id && check.state === "manual",
      ) ||
      typeof value.attemptId !== "string" ||
      !uuid.test(value.attemptId) ||
      !Number.isFinite(value.createdAt) ||
      value.createdAt > now ||
      now - value.createdAt > 86400000 ||
      (value.operation === "sendData" &&
        value.data !== `lo-sdk-test:${value.attemptId}`)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function ownsDeferredTicket(
  storage: Storage,
  ticket: DeferredTicket,
): boolean {
  try {
    const current = JSON.parse(storage.getItem(deferredKey) ?? "null");
    return (
      current?.attemptId === ticket.attemptId &&
      current?.runId === ticket.runId &&
      current?.id === ticket.id &&
      current?.appVersion === ticket.appVersion &&
      current?.appId === ticket.appId &&
      current?.userId === ticket.userId
    );
  } catch {
    return false;
  }
}
export function clearDeferredTicket(
  storage: Storage,
  ticket: DeferredTicket,
): void {
  if (ownsDeferredTicket(storage, ticket)) storage.removeItem(deferredKey);
}
export function applyDeferredResult(
  report: RunReport | null,
  ticket: DeferredTicket,
  result: Pick<CheckResult, "state" | "detail" | "evidence">,
): RunReport | null {
  if (
    !report ||
    report.id !== ticket.runId ||
    !canRunDeferred(report, ticket.id, ticket)
  )
    return report;
  const updated = normalizeProvenance(report);
  const execution = recordExecution(updated);
  return {
    ...updated,
    checks: updated.checks.map((check) =>
      check.id === ticket.id && check.state === "manual"
        ? {
            ...check,
            ...result,
            evidence: result.evidence,
            execution,
            durationExecution: check.durationExecution ?? check.execution,
          }
        : check,
    ),
  };
}

export function persistDeferredResult(
  storage: Storage,
  report: RunReport | null,
  ticket: DeferredTicket,
  result: Parameters<typeof applyDeferredResult>[2],
  appVersion: string,
  dependencies: string,
  identity: DeferredIdentity | null,
  now = Date.now(),
): RunReport | null {
  if (
    !identity ||
    readDeferredTicket(storage, report, appVersion, identity, now)
      ?.attemptId !== ticket.attemptId ||
    !ownsDeferredTicket(storage, ticket)
  )
    return report;
  const updated = applyDeferredResult(report, ticket, result);
  if (!updated || updated === report) return report;
  // Persist the confirmation before retiring its ticket. A failed write must
  // leave the original pending attempt available after reopening.
  saveRun(storage, updated, ticket.appVersion, dependencies);
  try {
    clearDeferredTicket(storage, ticket);
  } catch {
    // A terminal saved check makes a leftover ticket unreadable.
  }
  return updated;
}

export async function verifyDeferredData(
  ticket: DeferredTicket,
  launchData: string | undefined,
  request: <T>(path: string, body: unknown, signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  verified?: () => void,
): Promise<true> {
  if (ticket.operation !== "sendData" || !launchData)
    throw new Error(
      "Откройте тест из LO заново: нет подписанных данных запуска",
    );
  const probe = () =>
    request<{ found: boolean }>(
      "send-data/verify",
      {
        data: ticket.data,
        userId: ticket.userId,
        appId: ticket.appId,
      },
      signal,
    );
  let result: { found: boolean };
  try {
    result = await probe();
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error;
    signal.throwIfAborted();
    const signed = await request<{ userId: string; appId: string }>(
      "session",
      { raw: launchData },
      signal,
    );
    if (signed.userId !== ticket.userId || signed.appId !== ticket.appId)
      throw new Error("Эта попытка относится к другому запуску LO", {
        cause: error,
      });
    signal.throwIfAborted();
    verified?.();
    result = await probe();
  }
  signal.throwIfAborted();
  if (result.found !== true)
    throw new Error(
      "В текущей выборке обновлений точный код не найден. Повторите проверку позже; отсутствие в выборке не доказывает отказ доставки.",
    );
  return true;
}
