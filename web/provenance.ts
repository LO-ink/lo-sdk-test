import sdkBuild from "../sdk-build.json";

declare const __BUILD_REVISION__: string;
export type BuildReceipt = {
  appVersion: string;
  sourceRevision: string;
  packages: {
    name: string;
    version: string;
    sourceCommit: string;
    integrity: string;
  }[];
  configuredGoVerifier: {
    module: string;
    version: string;
    sourceCommit: string;
    toolchain: string;
  };
};
export type Execution = {
  build: string | null;
  evaluatedAt?: string;
  unknown?:
    "legacy" | "invalid-metadata" | "receipt-capacity" | "not-evaluated";
};
export type ResumeVerification = {
  id: "server" | "signature";
  state: "passed" | "skipped";
  completedAt: string;
};
export type Preparation = {
  execution: Execution;
  state: "running" | "passed" | "failed" | "cancelled";
  finishedAt?: string;
  verification?: ResumeVerification[];
};
export type Provenance = {
  schema: 1;
  builds: Record<string, BuildReceipt>;
  latestResumePreparation?: Preparation;
};
type Recorded = {
  checks: { execution?: Execution; durationExecution?: Execution }[];
  provenance?: Provenance;
};
const maxBuilds = 64;
const maxBytes = 128 * 1024;
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const version = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 50 &&
  /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(v);
const commit = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const date = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 30 && Number.isFinite(Date.parse(v));
function receipt(value: unknown): BuildReceipt | null {
  if (
    !object(value) ||
    !version(value.appVersion) ||
    !(value.sourceRevision === "local" || commit(value.sourceRevision)) ||
    !Array.isArray(value.packages) ||
    value.packages.length !== 4 ||
    !object(value.configuredGoVerifier)
  )
    return null;
  const packages: BuildReceipt["packages"] = [];
  for (const p of value.packages) {
    if (
      !object(p) ||
      typeof p.name !== "string" ||
      ![
        "@lo-ink/miniapp-sdk",
        "@lo-ink/bot-sdk",
        "@lo-ink/ui",
        "@lo-ink/design-tokens",
      ].includes(p.name) ||
      !version(p.version) ||
      !commit(p.sourceCommit) ||
      typeof p.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity)
    )
      return null;
    packages.push({
      name: p.name,
      version: p.version,
      sourceCommit: p.sourceCommit,
      integrity: p.integrity,
    });
  }
  if (new Set(packages.map((p) => p.name)).size !== 4) return null;
  const go = value.configuredGoVerifier;
  if (
    go.module !== "github.com/LO-ink/lo-miniapp-sdk/go" ||
    !version(go.version) ||
    !commit(go.sourceCommit) ||
    typeof go.toolchain !== "string" ||
    !/^go\d+\.\d+\.\d+$/.test(go.toolchain)
  )
    return null;
  return {
    appVersion: value.appVersion,
    sourceRevision: value.sourceRevision,
    packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
    configuredGoVerifier: {
      module: go.module,
      version: go.version,
      sourceCommit: go.sourceCommit,
      toolchain: go.toolchain,
    },
  };
}
// This identifies the recording browser build. The Go receipt is configuration,
// not a response-bound measurement of a remote server or native client binary.
export const currentBuild: BuildReceipt = receipt({
  appVersion: sdkBuild.appVersion,
  sourceRevision:
    typeof __BUILD_REVISION__ === "undefined" ? "local" : __BUILD_REVISION__,
  packages: sdkBuild.packages,
  configuredGoVerifier: sdkBuild.goVerifier,
})!;
function execution(value: unknown, builds: Provenance["builds"]): Execution {
  if (value === undefined) return { build: null, unknown: "legacy" };
  if (!object(value)) return { build: null, unknown: "invalid-metadata" };
  const evaluatedAt = date(value.evaluatedAt) ? value.evaluatedAt : undefined;
  if (
    typeof value.build === "string" &&
    Object.hasOwn(builds, value.build) &&
    evaluatedAt
  )
    return { build: value.build, evaluatedAt };
  if (
    value.build === null &&
    typeof value.unknown === "string" &&
    [
      "legacy",
      "invalid-metadata",
      "receipt-capacity",
      "not-evaluated",
    ].includes(value.unknown)
  )
    return {
      build: null,
      unknown: value.unknown as Execution["unknown"],
      ...(evaluatedAt ? { evaluatedAt } : {}),
    };
  return { build: null, unknown: "invalid-metadata" };
}
/** Optional provenance must never erase a valid recovery ledger. */
export function normalizeProvenance<T extends Recorded>(report: T): T {
  const raw: unknown = report.provenance;
  const builds: Provenance["builds"] = {};
  if (
    object(raw) &&
    raw.schema === 1 &&
    object(raw.builds) &&
    Object.keys(raw.builds).length <= maxBuilds
  ) {
    for (const [key, value] of Object.entries(raw.builds)) {
      if (!/^b[1-9]\d{0,5}$/.test(key)) continue;
      const parsed = receipt(value);
      if (
        parsed &&
        JSON.stringify(builds).length + JSON.stringify(parsed).length <=
          maxBytes
      )
        builds[key] = parsed;
    }
  }
  const provenance: Provenance = { schema: 1, builds };
  if (object(raw) && object(raw.latestResumePreparation)) {
    const p = raw.latestResumePreparation;
    if (
      typeof p.state === "string" &&
      ["running", "passed", "failed", "cancelled"].includes(p.state)
    )
      provenance.latestResumePreparation = {
        execution: execution(p.execution, builds),
        state: p.state as Preparation["state"],
        ...(date(p.finishedAt) ? { finishedAt: p.finishedAt } : {}),
        ...(Array.isArray(p.verification) &&
        p.verification.length <= 2 &&
        new Set(p.verification.map((v) => (object(v) ? v.id : null))).size ===
          p.verification.length &&
        p.verification.every(
          (v) =>
            object(v) &&
            typeof v.id === "string" &&
            ["server", "signature"].includes(v.id) &&
            typeof v.state === "string" &&
            ["passed", "skipped"].includes(v.state) &&
            date(v.completedAt),
        )
          ? {
              verification: p.verification.map((v) => ({
                id: v.id,
                state: v.state,
                completedAt: v.completedAt,
              })),
            }
          : {}),
      };
  }
  const result = {
    ...report,
    provenance,
    checks: report.checks.map((c) => ({
      ...c,
      execution: execution(c.execution, builds),
      ...(c.durationExecution !== undefined
        ? { durationExecution: execution(c.durationExecution, builds) }
        : {}),
    })),
  };
  prune(result);
  return result as T;
}
function prune(report: Recorded) {
  if (!report.provenance) return;
  const refs = new Set(
    report.checks.flatMap((c) => [
      c.execution?.build,
      c.durationExecution?.build,
    ]),
  );
  refs.add(report.provenance.latestResumePreparation?.execution.build);
  for (const key of Object.keys(report.provenance.builds))
    if (!refs.has(key)) delete report.provenance.builds[key];
}
/** Fixed bounded metadata; capacity never substitutes another build or blocks cleanup. */
export function recordExecution(
  report: Recorded,
  build: BuildReceipt = currentBuild,
): Execution {
  report.provenance ??= { schema: 1, builds: {} };
  prune(report);
  const evaluatedAt = new Date().toISOString();
  const parsed = receipt(build);
  if (!parsed) return { build: null, unknown: "invalid-metadata", evaluatedAt };
  const canonical = JSON.stringify(parsed);
  for (const [key, value] of Object.entries(report.provenance.builds))
    if (JSON.stringify(value) === canonical) return { build: key, evaluatedAt };
  const builds = report.provenance.builds;
  if (
    Object.keys(builds).length >= maxBuilds ||
    JSON.stringify(builds).length + canonical.length > maxBytes
  )
    return { build: null, unknown: "receipt-capacity", evaluatedAt };
  let id = 1;
  while (Object.hasOwn(builds, `b${id}`)) id++;
  builds[`b${id}`] = parsed;
  return { build: `b${id}`, evaluatedAt };
}
export function exportContext() {
  return {
    createdAt: new Date().toISOString(),
    build: currentBuild,
    scope: "exporting-browser-build",
    remoteBinaryIdentity: "not-measured",
  };
}

export function attributionSummary(report: Recorded) {
  const normalized = normalizeProvenance(report);
  const byBuild: Record<string, number> = {};
  let unknown = 0,
    notEvaluated = 0;
  for (const check of normalized.checks) {
    const value = check.execution!;
    if (value.build) byBuild[value.build] = (byBuild[value.build] ?? 0) + 1;
    else if (value.unknown === "not-evaluated") notEvaluated++;
    else unknown++;
  }
  return {
    byBuild,
    unknown,
    notEvaluated,
    scope: "recorded-evaluations-across-builds-not-current-build-certification",
  };
}
