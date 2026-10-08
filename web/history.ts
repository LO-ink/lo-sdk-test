import { readRun, readStoredRun, sameOwner } from "./run-storage.ts";
import { hasRecoveryDebt, type RunReport } from "./runner.ts";
import { lastRunKey, manualArchiveKey } from "./manual-recovery.ts";

type Reader = Pick<Storage, "getItem">;
type ArchiveStorage = Pick<Storage, "getItem" | "setItem" | "length" | "key">;
export const historyPrefix = "sdk-test.history.";
const maxRecords = 20;
const maxBytes = 8 * 1024 * 1024;
export type HistoricalReport = {
  snapshot: string;
  appVersion: string;
  dependencies: string;
  report: RunReport;
  reason: "expired" | "changed";
};
const changed =
  "Прежний отчёт или архив изменился. Откройте приложение заново; сохранённые данные не заменены.";
export function historyKey(snapshot: string) {
  return historyPrefix + manualArchiveKey(snapshot).split(".").at(-1);
}
/** Stale evidence is decoded without ever normalizing interrupted results. */
export function readHistorical(
  storage: Reader,
  dependencies: string,
  now = Date.now(),
): HistoricalReport | null {
  const snapshot = storage.getItem(lastRunKey);
  if (!snapshot) return null;
  const source = {
    getItem: (key: string) =>
      key === lastRunKey ? snapshot : storage.getItem(key),
    setItem: () => {},
  };
  if (readRun(source, dependencies, now)) return null;
  const report = readStoredRun(source, dependencies, now, true);
  if (!report || hasRecoveryDebt(report)) return null;
  const saved = JSON.parse(snapshot);
  if (
    typeof saved.appVersion !== "string" ||
    !saved.appVersion ||
    saved.appVersion.length > 100
  )
    return null;
  return {
    snapshot,
    appVersion: saved.appVersion,
    dependencies: saved.dependencies,
    report,
    reason:
      now - Date.parse(report.startedAt) > 86400000 ? "expired" : "changed",
  };
}
export function assertHistoryOwner(
  history: HistoricalReport,
  owner: RunReport["owner"],
) {
  if (
    !owner?.appId ||
    !owner.userId ||
    !history.report.owner ||
    !sameOwner(history.report, owner)
  )
    throw new Error(
      "Откройте прежний отчёт в том же приложении и аккаунте LO.",
    );
}
function exportText(value: string): string {
  const redact = (text: string) =>
    text
      .replace(
        /\b(?:Bearer|Basic)\s+[a-z0-9._~+/-]+=*/gi,
        "[redacted authorization]",
      )
      .replace(
        /\b([a-z0-9_-]*(?:init[_-]?data|authorization|token|hash|signature|query[_-]?id)[a-z0-9_-]*)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi,
        "$1=[redacted]",
      );
  let decoded = value;
  for (let i = 0; i < 2; i++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  const safe = redact(decoded);
  return safe !== decoded ? safe : redact(value);
}
export function historicalExport(
  history: HistoricalReport,
  owner: RunReport["owner"],
): string {
  assertHistoryOwner(history, owner);
  const report = history.report;
  return JSON.stringify(
    {
      schema: 1,
      kind: "lo-sdk-test-historical-report",
      historical: true,
      currentEvidence: false,
      appVersion: exportText(history.appVersion),
      dependencies: exportText(history.dependencies),
      report: {
        id: report.id,
        owner: { appId: report.owner!.appId, userId: report.owner!.userId },
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        state: report.state,
        suiteRevision: report.suiteRevision,
        assistedBridge: report.assistedBridge,
        checks: report.checks.map((check) => ({
          id: exportText(check.id),
          label: exportText(check.label),
          group: exportText(check.group),
          state: check.state,
          detail: exportText(check.detail),
          durationMs: check.durationMs,
          bridge: check.bridge ? exportText(check.bridge) : undefined,
          evidence: check.evidence,
          phase: check.phase,
          interrupted: check.interrupted,
          scopeExcluded: check.scopeExcluded,
        })),
      },
    },
    null,
    2,
  );
}
function matches(raw: string | null, snapshot: string) {
  if (!raw || raw.length * 2 > maxBytes) return false;
  try {
    const value = JSON.parse(raw);
    return (
      value.schema === 1 &&
      value.kind === "historical-report" &&
      value.currentEvidence === false &&
      value.snapshot === snapshot
    );
  } catch {
    return false;
  }
}
export function assertHistoryArchived(
  storage: Reader,
  history: HistoricalReport,
) {
  if (!matches(storage.getItem(historyKey(history.snapshot)), history.snapshot))
    throw new Error(changed);
}
export function preserveHistory(
  storage: ArchiveStorage,
  history: HistoricalReport,
) {
  const current = () => {
    if (storage.getItem(lastRunKey) !== history.snapshot)
      throw new Error(changed);
  };
  current();
  const key = historyKey(history.snapshot);
  const existing = storage.getItem(key);
  if (existing !== null) {
    assertHistoryArchived(storage, history);
    current();
    return;
  }
  const value = JSON.stringify({
    schema: 1,
    kind: "historical-report",
    currentEvidence: false,
    snapshot: history.snapshot,
  });
  let count = 0,
    bytes = (key.length + value.length) * 2;
  for (let i = 0; i < storage.length; i++) {
    const name = storage.key(i);
    if (!name?.startsWith(historyPrefix)) continue;
    const raw = storage.getItem(name);
    if (raw === null) continue;
    count++;
    bytes += (name.length + raw.length) * 2;
  }
  if (count >= maxRecords || bytes > maxBytes)
    throw new Error(
      "Архив отчётов заполнен. Освободите место, сохранив и удалив свою архивную копию. Для чужих записей нужен прежний аккаунт; повреждённое или полностью заполненное хранилище требует помощи владельца устройства. Старые записи не удалены.",
    );
  current();
  if (storage.getItem(key) !== null) throw new Error(changed);
  // Optimistic fences cannot turn localStorage into an atomic cross-tab transaction.
  storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw new Error(changed);
  current();
}
/** One most-recent retained report, never an execution or cleanup input. */
export function readArchivedHistory(
  storage: ArchiveStorage,
  dependencies: string,
  now = Date.now(),
): HistoricalReport | null {
  let latest: HistoricalReport | null = null;
  let records = 0,
    bytes = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(historyPrefix)) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    records++;
    bytes += (key.length + raw.length) * 2;
    if (records > maxRecords || bytes > maxBytes)
      throw new Error("Архив отчётов превышает допустимый размер");
    try {
      const value = JSON.parse(raw);
      if (
        typeof value.snapshot !== "string" ||
        historyKey(value.snapshot) !== key ||
        !matches(raw, value.snapshot)
      )
        continue;
      const candidate = readHistorical(
        { getItem: (name) => (name === lastRunKey ? value.snapshot : null) },
        dependencies,
        now,
      );
      if (
        candidate &&
        (!latest ||
          Date.parse(candidate.report.startedAt) >
            Date.parse(latest.report.startedAt))
      )
        latest = candidate;
    } catch {
      /* Invalid archives cannot certify or disclose report contents. */
    }
  }
  return latest;
}
export function oldestOwnedArchive(
  storage: ArchiveStorage,
  dependencies: string,
  owner: RunReport["owner"],
  now = Date.now(),
): HistoricalReport | null {
  let oldest: HistoricalReport | null = null;
  let count = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(historyPrefix)) continue;
    if (++count > maxRecords)
      throw new Error("Архив отчётов превышает допустимый размер");
    const raw = storage.getItem(key);
    if (!raw || raw.length * 2 > maxBytes) continue;
    try {
      const value = JSON.parse(raw);
      if (
        typeof value.snapshot !== "string" ||
        historyKey(value.snapshot) !== key ||
        !matches(raw, value.snapshot)
      )
        continue;
      const candidate = readHistorical(
        { getItem: (name) => (name === lastRunKey ? value.snapshot : null) },
        dependencies,
        now,
      );
      if (
        candidate?.report.owner &&
        owner?.appId &&
        owner.userId &&
        sameOwner(candidate.report, owner) &&
        (!oldest ||
          Date.parse(candidate.report.startedAt) <
            Date.parse(oldest.report.startedAt))
      )
        oldest = candidate;
    } catch {
      /* Untrusted archive data cannot authorize deletion. */
    }
  }
  return oldest;
}
/** Explicit post-export retirement never edits a run or attests its cleanup. */
export function retireHistory(
  storage: ArchiveStorage & Pick<Storage, "removeItem">,
  history: HistoricalReport,
  owner: RunReport["owner"],
  expectedRun: string | null,
  confirmed: boolean,
) {
  if (!confirmed)
    throw new Error(
      "Сначала сохраните копию отчёта и подтвердите удаление локального архива.",
    );
  assertHistoryOwner(history, owner);
  const current = () => {
    if (storage.getItem(lastRunKey) !== expectedRun) throw new Error(changed);
  };
  current();
  const key = historyKey(history.snapshot),
    raw = storage.getItem(key);
  if (!matches(raw, history.snapshot)) throw new Error(changed);
  current();
  if (storage.getItem(key) !== raw) throw new Error(changed);
  // As with writes, these comparisons detect observed conflicts, not an atomic CAS.
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error(changed);
  current();
}
