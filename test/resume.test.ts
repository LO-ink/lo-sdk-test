import assert from "node:assert/strict";
import test from "node:test";
import {
  canResume,
  hasRecoveryDebt,
  runChecks,
  type Check,
  type CheckResult,
  type RunReport,
} from "../web/runner.ts";
import {
  dependencyKey,
  lastRunKey,
  readRun,
  sameOwner,
  saveRun,
} from "../web/run-storage.ts";
import { createSuite, type SuiteContext } from "../web/suite.ts";
import sdkBuild from "../sdk-build.json";
import type { MiniAppClient } from "@lo-ink/miniapp-sdk";
const id = "11111111-1111-4111-8111-111111111111";
const dependencies = dependencyKey(sdkBuild.packages);
const result = (id: string, state: CheckResult["state"]): CheckResult => ({
  id,
  label: id,
  group: "fixture",
  state,
  detail: "Original evidence",
  durationMs: 10,
});
const report = (): RunReport => ({
  id,
  startedAt: new Date().toISOString(),
  state: "cancelled",
  suiteRevision: 1,
  checks: [
    result("done", "passed"),
    result("next", "cancelled"),
    result("cleanup", "passed"),
  ],
});
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
const check = (id: string, execute: Check["execute"]): Check => ({
  id,
  label: id,
  group: "fixture",
  execute,
});

test("continuation preserves completed evidence and run identity, retries only unfinished checks and always cleans", async () => {
  const before = report();
  before.checks.splice(
    1,
    0,
    result("failed", "failed"),
    result("manual", "manual"),
    result("skipped", "skipped"),
  );
  const original = structuredClone(before);
  const calls: string[] = [];
  const plan = before.checks.slice(0, -1).map((row) =>
    check(row.id, async () => {
      calls.push(row.id);
      return "New response";
    }),
  );
  const snapshots: RunReport[] = [];
  const after = await runChecks(
    plan,
    check("cleanup", async () => {
      calls.push("cleanup");
      return "Clean";
    }),
    new AbortController().signal,
    (r) => snapshots.push(r),
    100,
    {
      previous: before,
      prepare: async () => {
        calls.push("prepare");
      },
    },
  );
  assert.deepEqual(calls, ["prepare", "next", "cleanup"]);
  assert.equal(after.id, before.id);
  assert.equal(after.startedAt, before.startedAt);
  assert.equal(after.state, "finished");
  assert.deepEqual(after.checks.slice(0, 4), before.checks.slice(0, 4));
  assert.deepEqual(before, original);
  assert.equal(snapshots[0].checks[4].state, "pending");
  assert.equal(snapshots[0].checks[0].state, "passed");
  assert.equal(canResume(after), false);
});

test("mismatched plans are refused without executing cleanup or replacing history", async () => {
  const before = report();
  let called = false;
  const action = async () => {
    called = true;
    return "unused";
  };
  await assert.rejects(
    runChecks(
      [check("changed", action), check("next", action)],
      check("cleanup", action),
      new AbortController().signal,
      () => {},
      100,
      { previous: before },
    ),
  );
  assert.equal(called, false);
});

test("fresh prerequisite failure retains results, leaves remaining checks resumable and performs cleanup", async () => {
  const before = report();
  let cleaned = false;
  const after = await runChecks(
    [
      check("done", async () => "unused"),
      check("next", async () => assert.fail("must not execute")),
    ],
    check("cleanup", async (signal) => {
      assert.equal(signal.aborted, false);
      cleaned = true;
      return "clean";
    }),
    new AbortController().signal,
    () => {},
    100,
    {
      previous: before,
      prepare: async () => {
        throw new Error("New signature refused");
      },
    },
  );
  assert.equal(cleaned, true);
  assert.equal(after.resumeError, "New signature refused");
  assert.equal(after.state, "cancelled");
  assert.deepEqual(after.checks[0], before.checks[0]);
  assert.equal(canResume(after), true);
});

test("reopening distinguishes interrupted actions from untouched future steps and keeps cleanup debt across two reloads", () => {
  const store = storage();
  const before = report();
  before.state = "running";
  before.checks[1].state = "running";
  before.checks.splice(2, 0, result("never", "pending"));
  before.checks.at(-1)!.state = "pending";
  before.recovery = Object.fromEntries(
    ["native", "compat"].map((bridge) => [
      bridge,
      {
        key: `lo-sdk-run-${id}-${bridge}`,
        written: ["cloudStorage"],
        mutations: ["startAccelerometer"],
        original: { isOrientationLocked: false },
      },
    ]),
  );
  saveRun(store, before, "0.4.22", dependencies);
  const first = readRun(store, dependencies)!;
  assert.equal(first.checks[1].interrupted, true);
  assert.equal(first.checks[2].interrupted, undefined);
  assert.equal(first.state, "cancelled");
  assert.deepEqual(first.recovery, before.recovery);
  assert.equal(hasRecoveryDebt(first), true);
  assert.equal(canResume(first), true);
  saveRun(store, first, "0.4.22", dependencies);
  const second = readRun(store, dependencies)!;
  assert.deepEqual(second.recovery, before.recovery);
  assert.equal(second.checks[1].interrupted, true);
});

test("stored runs require bounded valid metadata, current dependencies, owned keys and known recovery operations", () => {
  const store = storage(),
    before = report();
  saveRun(store, before, "0.4.22", dependencies);
  const saved = JSON.parse(store.getItem(lastRunKey)!) as {
    schema: number;
    dependencies: string;
    report: RunReport;
  };
  const invalid = [
    { ...saved, schema: 2 },
    { ...saved, dependencies: "different" },
    {
      ...saved,
      report: {
        ...before,
        startedAt: new Date(Date.now() + 60000).toISOString(),
      },
    },
    {
      ...saved,
      report: {
        ...before,
        startedAt: new Date(Date.now() - 86400001).toISOString(),
      },
    },
    {
      ...saved,
      report: { ...before, checks: [...before.checks, before.checks[0]] },
    },
    {
      ...saved,
      report: { ...before, checks: [result("broken", "unknown" as never)] },
    },
    {
      ...saved,
      report: {
        ...before,
        recovery: {
          native: {
            key: "unrelated-user-key",
            written: ["cloudStorage"],
            mutations: [],
            original: {},
          },
        },
      },
    },
    {
      ...saved,
      report: {
        ...before,
        recovery: {
          native: {
            key: `lo-sdk-run-${id}-native`,
            written: [],
            mutations: ["sendMessage"],
            original: {},
          },
        },
      },
    },
  ];
  for (const value of invalid) {
    store.setItem(lastRunKey, JSON.stringify(value));
    assert.equal(readRun(store, dependencies), null);
  }
  store.setItem(lastRunKey, "{");
  assert.equal(readRun(store, dependencies), null);
  store.setItem(lastRunKey, "x".repeat(2000001));
  assert.equal(readRun(store, dependencies), null);
  assert.equal(sameOwner(before, undefined), true);
  before.owner = { appId: "app", userId: "user" };
  assert.equal(sameOwner(before, { appId: "app", userId: "other" }), false);
});

test("only the reviewed 0.4.21 dependency set migrates, and unconfirmed old cleanup blocks resume", () => {
  const store = storage(),
    before = report();
  store.setItem(
    lastRunKey,
    JSON.stringify({ appVersion: "0.4.21", report: before }),
  );
  assert.equal(readRun(store, dependencies)?.id, id);
  assert.equal(readRun(store, "changed"), null);
  before.checks.at(-1)!.state = "pending";
  store.setItem(
    lastRunKey,
    JSON.stringify({ appVersion: "0.4.21", report: before }),
  );
  assert.equal(canResume(readRun(store, dependencies)), false);
  store.setItem(
    lastRunKey,
    JSON.stringify({ appVersion: "0.4.20", report: report() }),
  );
  assert.equal(readRun(store, dependencies), null);
});

function suiteFixture(
  resumeChecks: CheckResult[],
  recovery?: NonNullable<RunReport["recovery"]>[string],
) {
  const values = new Map<string, string>();
  const calls: string[] = [];
  const checkpoints: string[] = [];
  const client = {
    adapter: {
      launchData: "signed-fixture",
      snapshot: () => ({ isOrientationLocked: false }),
    },
    supports: () => true,
    call: async (name: string, input: { key?: string; value?: string }) => {
      calls.push(name);
      if (name.endsWith("Set")) {
        values.set(input.key!, input.value!);
        return true;
      }
      if (name.endsWith("Get")) return values.get(input.key!);
      if (name.endsWith("Remove")) {
        values.delete(input.key!);
        return true;
      }
      return true;
    },
  } as unknown as MiniAppClient;
  const api: SuiteContext["api"] = async <T>(path: string) => {
    calls.push(`api:${path}`);
    return {
      status: { appConfigured: true, botConfigured: true },
      session: {
        verified: true,
        resources: { message: false, files: [], metadata: false },
      },
      consent: { accepted: true },
    }[path] as T;
  };
  const suite = createSuite({
    client,
    api,
    runId: id,
    bridgeId: "native",
    resumeChecks,
    recovery,
    consent: null,
    includeBot: true,
    verified: () => {},
    observed: () => ({}),
    writeAccess: Promise.resolve({ allowed: true }),
    checkpoint: () => checkpoints.push(JSON.stringify(suite.checkpoint())),
  });
  return { suite, calls, checkpoints, values };
}

test("resume seeds dirty recovery before publication, undoes it and proves new owned fixtures before dependent reads", async () => {
  const recovery = {
    key: `lo-sdk-run-${id}-native`,
    written: ["cloudStorage"],
    mutations: ["startAccelerometer"],
    original: { isOrientationLocked: false },
  };
  const { suite, calls, checkpoints, values } = suiteFixture(
    [
      result("cloudStorageSet", "passed"),
      result("cloudStorageGet", "cancelled"),
    ],
    recovery,
  );
  assert.deepEqual(suite.checkpoint().written, ["cloudStorage"]);
  assert.deepEqual(suite.checkpoint().mutations, ["startAccelerometer"]);
  await suite.prepareResume(new AbortController().signal);
  assert.ok(
    calls.indexOf("stopAccelerometer") < calls.indexOf("cloudStorageSet"),
  );
  assert.ok(
    checkpoints.some((raw) => JSON.parse(raw).written.includes("cloudStorage")),
  );
  const read = suite.plan.find((check) => check.id === "cloudStorageGet")!;
  assert.equal(read.skip?.(), undefined);
  await read.execute(new AbortController().signal);
  await suite.cleanup.execute(new AbortController().signal);
  assert.equal(values.size, 0);
  assert.deepEqual(suite.checkpoint().written, []);
  assert.deepEqual(suite.checkpoint().mutations, []);
});

test("expired bot resources remain unverified, and interrupted sends require a specific retry choice", async () => {
  const { suite, calls } = suiteFixture([result("bot:sendMessage", "passed")]);
  await suite.prepareResume(new AbortController().signal);
  assert.equal(
    suite.plan.find((check) => check.id === "bot:editMessage")!.skip?.()?.state,
    "manual",
  );
  assert.equal(calls.includes("api:bot"), false);
  let warning = "";
  const interrupted = {
    ...result("bot:sendMessage", "cancelled"),
    interrupted: true,
  };
  const retry = createSuite({
    client: {
      adapter: { launchData: "signed" },
      supports: () => true,
    } as unknown as MiniAppClient,
    resumeChecks: [interrupted],
    consent: null,
    includeBot: true,
    writeAccess: Promise.resolve({ allowed: true }),
    verified: () => {},
    observed: () => ({}),
    api: async <T>(path: string) => {
      assert.notEqual(path, "bot");
      return { appConfigured: true, botConfigured: true, verified: true } as T;
    },
    interact: async (request) => {
      warning = request.detail;
      return { decision: "skip" };
    },
  });
  await retry.prepareResume(new AbortController().signal);
  const outcome = await retry.plan
    .find((check) => check.id === "bot:sendMessage")!
    .execute(new AbortController().signal);
  assert.match(warning, /мог уже выполнить/);
  assert.equal(typeof outcome === "object" && outcome.state, "manual");
});

test("successful inverse cleanup retires scanner and fullscreen intents without exiting an originally fullscreen host", async () => {
  for (const isFullscreen of [false, true]) {
    const { suite, calls } = suiteFixture([], {
      key: `lo-sdk-run-${id}-native`,
      written: [],
      mutations: ["openQrScanner", "requestFullscreen"],
      original: { isFullscreen },
    });
    await suite.cleanup.execute(new AbortController().signal);
    assert.equal(calls.includes("closeQrScanner"), true);
    assert.equal(calls.includes("exitFullscreen"), !isFullscreen);
    assert.deepEqual(suite.checkpoint().mutations, []);
    assert.equal(suite.cleanup.skip?.()?.state, "skipped");
  }
});

test("the reviewed UI-only upgrade preserves a 0.4.22 run but rejects execution or provenance changes", () => {
  const oldPackages = sdkBuild.packages.map((entry) => ({
    ...entry,
    version: ["@lo-ink/ui", "@lo-ink/design-tokens"].includes(entry.name)
      ? "0.1.1"
      : entry.version,
  }));
  const upgradedPackages = oldPackages.map((entry) => ({
    ...entry,
    version: ["@lo-ink/ui", "@lo-ink/design-tokens"].includes(entry.name)
      ? "0.2.0"
      : entry.version,
  }));
  const previous = dependencyKey(oldPackages);
  const upgraded = dependencyKey(upgradedPackages);
  const before = report();
  before.owner = { appId: "example-app", userId: "example-user" };
  const store = storage();
  saveRun(store, before, "0.4.22", previous);
  const migrated = readRun(store, upgraded)!;
  assert.deepEqual(migrated, before);
  assert.equal(canResume(migrated), true);
  assert.equal(
    sameOwner(migrated, { appId: "example-app", userId: "another-user" }),
    false,
  );
  const changedSdk = upgradedPackages.map((entry) => ({
    ...entry,
    version: entry.name === "@lo-ink/miniapp-sdk" ? "0.21.2" : entry.version,
  }));
  assert.equal(readRun(store, dependencyKey(changedSdk)), null);
  const raw = JSON.parse(store.getItem(lastRunKey)!) as {
    appVersion: string;
    schema: number;
  };
  raw.appVersion = "0.4.20";
  store.setItem(lastRunKey, JSON.stringify(raw));
  assert.equal(readRun(store, upgraded), null);
  raw.appVersion = "0.4.22";
  raw.schema = 2;
  store.setItem(lastRunKey, JSON.stringify(raw));
  assert.equal(readRun(store, upgraded), null);
});

test("the reviewed UI primitive and font upgrade preserves reviewed 0.4.22/0.4.23 runs and rejects unreviewed builds", () => {
  const previousPackages = sdkBuild.packages.map((entry) => ({
    ...entry,
    version: ["@lo-ink/ui", "@lo-ink/design-tokens"].includes(entry.name)
      ? "0.2.0"
      : entry.version,
  }));
  const targetPackages = previousPackages.map((entry) => ({
    ...entry,
    version: ["@lo-ink/ui", "@lo-ink/design-tokens"].includes(entry.name)
      ? "0.3.0"
      : entry.version,
  }));
  const dependencies = dependencyKey(targetPackages);
  const store = storage();
  const before = report();
  saveRun(store, before, "0.4.23", dependencyKey(previousPackages));
  assert.deepEqual(readRun(store, dependencies), before);
  assert.equal(
    readRun(
      store,
      dependencies.replace("@lo-ink/ui@0.3.0", "@lo-ink/ui@0.2.2"),
    ),
    null,
  );
  saveRun(store, before, "0.4.22", dependencyKey(previousPackages));
  assert.equal(readRun(store, dependencies), null);
  const oldPackages = previousPackages.map((entry) => ({
    ...entry,
    version: ["@lo-ink/ui", "@lo-ink/design-tokens"].includes(entry.name)
      ? "0.1.1"
      : entry.version,
  }));
  saveRun(store, before, "0.4.22", dependencyKey(oldPackages));
  assert.deepEqual(readRun(store, dependencies), before);
  saveRun(store, before, "0.4.20", dependencyKey(oldPackages));
  assert.equal(readRun(store, dependencies), null);
});
