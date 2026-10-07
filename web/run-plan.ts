import type { AssistedBridge, Check, CheckResult, RunPhase } from "./runner.ts";

const unattendedHost = new Set([
  "ready",
  "getBiometryInfo",
  "startAccelerometer",
  "stopAccelerometer",
  "startGyroscope",
  "stopGyroscope",
  "startDeviceOrientation",
  "stopDeviceOrientation",
]);
const unattendedBot = new Set([
  "getIdentity",
  "getCapabilities",
  "getCommands",
]);
const phaseOrder: Record<RunPhase, number> = {
  automatic: 0,
  assisted: 1,
  observation: 2,
  deferred: 3,
};

export function checkPhase(
  check: Pick<Check, "id">,
  previous?: CheckResult[],
): RunPhase {
  const id = check.id.replace(/^(native|compat):/, "");
  if (id === "close" || id === "sendData" || id === "bot:delivery")
    return "deferred";
  if (id.startsWith("event:")) return "observation";
  if (
    ["server", "signature", "safe-area", "audio-context"].includes(id) ||
    id.startsWith("errors:")
  )
    return "automatic";
  if (id.startsWith("bot:")) {
    const interrupted = previous?.some(
      (item) =>
        item.id === check.id &&
        item.interrupted &&
        ["running", "cancelled", "pending"].includes(item.state),
    );
    return !interrupted && unattendedBot.has(id.slice(4))
      ? "automatic"
      : "assisted";
  }
  if (
    unattendedHost.has(id) ||
    /^(cloud|device|secure)Storage(Set|Get|GetMany|Remove|RemoveMany|Keys)$/.test(
      id,
    )
  )
    return "automatic";
  return "assisted";
}

// Stable phase ordering preserves storage, sensor and bot dependency chains.
// Events remain after their producers; destructive end actions stay deferred.
export function orderRunPlan(
  plan: Check[],
  previous?: CheckResult[],
  assistedBridge?: AssistedBridge,
): Check[] {
  return plan
    .map((check) => {
      const phase = checkPhase(check, previous);
      const route = /^(native|compat):/.exec(check.id)?.[1];
      const saved = previous?.find((item) => item.id === check.id);
      const excluded =
        assistedBridge &&
        route &&
        route !== assistedBridge &&
        ["assisted", "deferred"].includes(phase) &&
        !check.id.endsWith(":system-theme") &&
        (!saved || ["running", "pending", "cancelled"].includes(saved.state));
      return excluded
        ? {
            ...check,
            phase,
            scopeExcluded: true,
            skip: () => ({
              state: "manual" as const,
              detail: `Для проверок с участием пользователя выбран ${assistedBridge === "native" ? "нативный" : "совместимый"} мост. Этот сценарий через другой мост не запускался.`,
            }),
          }
        : { ...check, phase };
    })
    .sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]);
}
