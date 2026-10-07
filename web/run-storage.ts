import {
  recoveryOperations,
  recoveryButtons,
  type CheckResult,
  type RunReport,
} from "./runner.ts";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export const lastRunKey = "sdk-test.last-run";
const states = new Set([
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
  "manual",
  "cancelled",
]);
const evidence = new Set(["response", "data", "device", "synthetic"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function dependencyKey(
  packages: ReadonlyArray<{ name: string; version: string }>,
): string {
  return packages
    .map((item) => `${item.name}@${item.version}`)
    .sort()
    .join("|");
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit;
function validCheck(value: unknown): value is CheckResult {
  return (
    object(value) &&
    text(value.id, 200) &&
    Boolean(value.id) &&
    text(value.label, 500) &&
    text(value.group, 500) &&
    text(value.detail, 20000) &&
    typeof value.state === "string" &&
    states.has(value.state) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    (value.bridge === undefined || text(value.bridge, 500)) &&
    (value.evidence === undefined ||
      (typeof value.evidence === "string" && evidence.has(value.evidence))) &&
    (value.interrupted === undefined || typeof value.interrupted === "boolean")
  );
}
function validRecovery(value: unknown, runId: string): boolean {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !["native", "compat"].includes(key))
  )
    return false;
  return Object.entries(value).every(([bridge, entry]) => {
    if (
      !object(entry) ||
      entry.key !== `lo-sdk-run-${runId}-${bridge}` ||
      !Array.isArray(entry.written) ||
      !entry.written.every((item) =>
        ["cloudStorage", "deviceStorage", "secureStorage"].includes(item),
      ) ||
      !Array.isArray(entry.mutations) ||
      !entry.mutations.every((item) =>
        (recoveryOperations as readonly unknown[]).includes(item),
      ) ||
      !object(entry.original)
    )
      return false;
    if (
      entry.buttons !== undefined &&
      (!Array.isArray(entry.buttons) ||
        !entry.buttons.length ||
        entry.buttons.length > 4 ||
        new Set(entry.buttons).size !== entry.buttons.length ||
        !entry.buttons.every((button) =>
          (recoveryButtons as readonly unknown[]).includes(button),
        ) ||
        !entry.mutations.includes("setButton"))
    )
      return false;
    const original = entry.original;
    if (
      Object.keys(original).some(
        (key) =>
          !["isOrientationLocked", "isFullscreen", "theme"].includes(key),
      )
    )
      return false;
    if (
      [original.isOrientationLocked, original.isFullscreen].some(
        (item) => item !== undefined && typeof item !== "boolean",
      )
    )
      return false;
    if (
      original.theme !== undefined &&
      (!object(original.theme) ||
        Object.entries(original.theme).some(
          ([key, color]) =>
            !["background", "headerBackground", "bottomBarBackground"].includes(
              key,
            ) ||
            typeof color !== "string" ||
            !/^#[0-9a-f]{6}$/i.test(color),
        ))
    )
      return false;
    return true;
  });
}
export function readRun(
  storage: Storage,
  dependencies: string,
  now = Date.now(),
): RunReport | null {
  try {
    const raw = storage.getItem(lastRunKey);
    if (!raw || raw.length > 2000000) return null;
    const saved: unknown = JSON.parse(raw);
    if (!object(saved) || !object(saved.report)) return null;
    if (saved.schema !== 1 || saved.dependencies !== dependencies) return null;
    const report = saved.report;
    if (
      !text(report.id, 36) ||
      !uuid.test(report.id) ||
      !text(report.startedAt, 100) ||
      !["running", "finished", "cancelled"].includes(String(report.state)) ||
      !Array.isArray(report.checks) ||
      !report.checks.length ||
      report.checks.length > 1000 ||
      !report.checks.every(validCheck) ||
      new Set(report.checks.map((check) => check.id)).size !==
        report.checks.length ||
      (report.finishedAt !== undefined &&
        (!text(report.finishedAt, 100) ||
          !Number.isFinite(Date.parse(report.finishedAt)))) ||
      (report.resumeBlocked !== undefined &&
        typeof report.resumeBlocked !== "boolean") ||
      (report.resumeError !== undefined && !text(report.resumeError, 20000)) ||
      (report.suiteRevision !== undefined && report.suiteRevision !== 1)
    )
      return null;
    const age = now - Date.parse(report.startedAt);
    if (!Number.isFinite(age) || age < 0 || age > 86400000) return null;
    if (
      report.owner !== undefined &&
      (!object(report.owner) ||
        !text(report.owner.appId, 128) ||
        !report.owner.appId ||
        !text(report.owner.userId, 128) ||
        !report.owner.userId)
    )
      return null;
    if (
      report.recovery !== undefined &&
      !validRecovery(report.recovery, report.id)
    )
      return null;
    const restored = report as RunReport;
    if (restored.state === "running") {
      restored.state = "cancelled";
      for (const check of restored.checks) {
        if (check.state === "running") {
          check.interrupted = true;
          check.state = "cancelled";
          check.detail = "Приложение было закрыто во время проверки";
        } else if (check.state === "pending") {
          check.state = "cancelled";
          check.detail = "Не запускалась: приложение было закрыто";
        }
      }
    }
    const cleaned = restored.checks.some(
      (check) => check.id === "cleanup" && check.state === "passed",
    );
    if (
      (!cleaned && !restored.recovery) ||
      restored.checks.some(
        (check) => check.id === "cleanup" && check.state === "failed",
      )
    )
      restored.resumeBlocked = true;
    return restored;
  } catch {
    return null;
  }
}
export function saveRun(
  storage: Storage,
  report: RunReport,
  appVersion: string,
  dependencies: string,
) {
  storage.setItem(
    lastRunKey,
    JSON.stringify({ schema: 1, appVersion, dependencies, report }),
  );
}
export function sameOwner(
  report: RunReport,
  owner: RunReport["owner"],
): boolean {
  return (
    report.owner?.appId === owner?.appId &&
    report.owner?.userId === owner?.userId
  );
}
