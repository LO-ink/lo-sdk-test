import type { Check, CheckResult, RunPhase } from "./runner.ts";

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
  const id = check.id.replace(/^native:/, "");
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
export function orderRunPlan(plan: Check[], previous?: CheckResult[]): Check[] {
  return plan
    .map((check) => ({ ...check, phase: checkPhase(check, previous) }))
    .sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]);
}
