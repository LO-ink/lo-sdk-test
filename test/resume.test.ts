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
import {
  createMiniAppClient,
  createNativeAdapter,
  type Capability,
  type MiniAppClient,
} from "@lo-ink/miniapp-sdk";
import { createWebAppAdapter } from "@lo-ink/adapter-webapp-compat";
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
    { ...saved, report: { ...before, assistedBridge: ["native"] } },
    {
      ...saved,
      report: {
        ...before,
        checks: before.checks.map((check) => ({
          ...check,
          phase: ["automatic"],
        })),
      },
    },
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
    writeAccess: () => Promise.resolve({ allowed: true }),
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
    writeAccess: () => Promise.resolve({ allowed: true }),
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

test("native SDK upgrades and schema-less historical reports cannot relabel old evidence", () => {
  const store = storage();
  const before = report();
  saveRun(store, before, "0.4.26", dependencies);
  assert.deepEqual(readRun(store, dependencies), before);
  const priorDependencies = dependencies.replace(
    /@lo-ink\/miniapp-sdk@[^|]+/,
    (current) => `${current}-historical`,
  );
  assert.notEqual(priorDependencies, dependencies);
  saveRun(store, before, "0.4.25", priorDependencies);
  assert.equal(readRun(store, dependencies), null);
  const legacy = { appVersion: "0.4.21", dependencies, report: before };
  store.setItem(lastRunKey, JSON.stringify(legacy));
  assert.equal(readRun(store, dependencies), null);
});

// Host fakes sit below the published SDK/adapters, so wire shapes and callback
// normalization remain real rather than being replaced by permissive call mocks.
function recoveryHost(bridge: "native" | "compat", initialFullscreen = false) {
  const state = { fullscreen: initialFullscreen, fail: false };
  const values = new Map<string, string>();
  const buttons = new Map<string, boolean>();
  const calls: string[] = [];
  const capabilities: Capability[] = [
    "mainButton",
    "secondaryButton",
    "backButton",
    "settingsButton",
    "secureStorage",
    "deviceStorage",
    "fullscreen",
  ];
  const setButton = (button: string, visible: boolean) => {
    calls.push("setButton");
    if (state.fail) throw new Error("Host rejected restoration");
    buttons.set(button, visible);
  };
  const fullscreen = (enabled: boolean) => {
    calls.push(enabled ? "requestFullscreen" : "exitFullscreen");
    if (state.fail) throw new Error("Host rejected restoration");
    state.fullscreen = enabled;
  };
  const storage = (secure: boolean) => ({
    setItem(
      key: string,
      value: string,
      done: (error: null, value: boolean) => void,
    ) {
      values.set(key, value);
      done(null, true);
    },
    getItem(
      key: string,
      done: (error: null, value: string | null, canRestore?: boolean) => void,
    ) {
      done(null, values.get(key) ?? null, secure ? false : undefined);
    },
    removeItem(key: string, done: (error: null, value: boolean) => void) {
      values.delete(key);
      done(null, true);
    },
  });
  let client: MiniAppClient;
  if (bridge === "compat") {
    client = createMiniAppClient(
      createWebAppAdapter(
        "fixture",
        {
          get isFullscreen() {
            return state.fullscreen;
          },
          MainButton: {
            setParams: (params: { is_visible: boolean }) =>
              setButton("main", params.is_visible),
          },
          SecondaryButton: {
            setParams: (params: { is_visible: boolean }) =>
              setButton("secondary", params.is_visible),
          },
          BackButton: {
            show: () => setButton("back", true),
            hide: () => setButton("back", false),
          },
          SettingsButton: {
            show: () => setButton("settings", true),
            hide: () => setButton("settings", false),
          },
          requestFullscreen: () => fullscreen(true),
          exitFullscreen: () => fullscreen(false),
          SecureStorage: storage(true),
          DeviceStorage: storage(false),
        },
        new Set(capabilities),
      ),
    );
  } else {
    const listeners = new Set<(raw: string) => void>();
    const adapter = createNativeAdapter({
      LO: {
        MiniAppNative: {
          protocolVersion: 1,
          generation: "recovery:fixture",
          launchData: "fixture-launch",
          operations: [
            "setButton",
            "requestFullscreen",
            "exitFullscreen",
            "secureStorageSet",
            "secureStorageGet",
            "secureStorageRemove",
            "deviceStorageSet",
            "deviceStorageGet",
            "deviceStorageRemove",
          ],
          capabilities,
          snapshot: () => ({ isFullscreen: state.fullscreen }),
          subscribe: (listener: (raw: string) => void) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          postMessage: (raw: string) => {
            const message = JSON.parse(raw);
            if (message.kind !== "request") return;
            const { operation, input } = message;
            let value: unknown = null;
            if (operation === "setButton")
              setButton(input.button, input.params.visible);
            else if (
              operation === "requestFullscreen" ||
              operation === "exitFullscreen"
            )
              fullscreen(operation === "requestFullscreen");
            else if (operation.endsWith("Set")) {
              values.set(input.key, input.value);
              value = true;
            } else if (operation.endsWith("Remove")) {
              values.delete(input.key);
              value = true;
            } else if (operation === "secureStorageGet")
              value = {
                value: values.get(input.key) ?? null,
                canRestore: false,
              };
            else if (operation === "deviceStorageGet")
              value = values.get(input.key) ?? null;
            else assert.fail(`Unexpected operation ${operation}`);
            for (const listener of listeners)
              listener(
                JSON.stringify({
                  channel: "lo.miniapp",
                  version: 1,
                  generation: "recovery:fixture",
                  kind: "result",
                  id: message.id,
                  ok: true,
                  value,
                }),
              );
          },
        },
      },
    });
    assert.ok(adapter);
    client = createMiniAppClient(adapter);
  }
  const context: SuiteContext = {
    client,
    runId: id,
    bridgeId: bridge,
    primary: false,
    api: async () => {
      throw new Error("No server calls expected");
    },
    consent: null,
    includeBot: false,
    verified() {},
    observed: () => ({}),
  };
  return { state, values, buttons, calls, client, context };
}

for (const bridge of ["native", "compat"] as const) {
  test(`${bridge}: real SDK button cleanup handles every button and retries preserved crash debt`, async () => {
    const host = recoveryHost(bridge);
    try {
      const observed: Record<string, string> = {};
      const suite = createSuite({
        ...host.context,
        observed: () => observed,
        interact: async (request) => {
          const value = await request.action!("");
          for (const button of ["main", "secondary", "back", "settings"])
            observed[`${button}ButtonClicked`] = crypto.randomUUID();
          return { decision: "yes", value };
        },
      });
      for (const name of [
        "setButton",
        "button:secondary",
        "button:back",
        "button:settings",
      ]) {
        await suite.plan
          .find((c) => c.id === name)!
          .execute(new AbortController().signal);
        assert.deepEqual(suite.checkpoint().mutations, ["setButton"]);
      }
      const saved = JSON.parse(JSON.stringify(suite.checkpoint()));
      host.state.fail = true;
      await assert.rejects(
        suite.cleanup.execute(new AbortController().signal),
        /setButton/,
      );
      assert.deepEqual(suite.checkpoint().mutations, ["setButton"]);
      host.state.fail = false;
      const reopened = createSuite({ ...host.context, recovery: saved });
      await reopened.prepareResume(new AbortController().signal);
      assert.deepEqual(
        [...host.buttons.values()],
        [false, false, false, false],
      );
      assert.deepEqual(reopened.checkpoint().mutations, []);
    } finally {
      host.client.dispose();
    }
  });

  test(`${bridge}: secure and device fixtures resume through their actual response contracts`, async () => {
    const host = recoveryHost(bridge);
    try {
      for (const storage of ["deviceStorage", "secureStorage"]) {
        const suite = createSuite({
          ...host.context,
          resumeChecks: [
            result(`${storage}Set`, "passed"),
            result(`${storage}Get`, "cancelled"),
            result(`${storage}Remove`, "cancelled"),
          ],
        });
        await suite.prepareResume(new AbortController().signal);
        const read = suite.plan.find((c) => c.id === `${storage}Get`)!;
        assert.equal(read.skip?.(), undefined);
        await read.execute(new AbortController().signal);
        await suite.cleanup.execute(new AbortController().signal);
        assert.equal(host.values.size, 0);
        assert.deepEqual(suite.checkpoint().written, []);
      }
    } finally {
      host.client.dispose();
    }
  });

  test(`${bridge}: both fullscreen directions restore the original state after cancellation and crash`, async () => {
    for (const original of [false, true]) {
      for (const operation of [
        "requestFullscreen",
        "exitFullscreen",
      ] as const) {
        const host = recoveryHost(bridge, original);
        try {
          let saved:
            | ReturnType<ReturnType<typeof createSuite>["checkpoint"]>
            | undefined;
          const controller = new AbortController();
          const suite = createSuite({
            ...host.context,
            interact: async (request) => {
              const value = await request.action!("");
              saved = JSON.parse(JSON.stringify(suite.checkpoint()));
              controller.abort();
              return { decision: "yes", value };
            },
          });
          const action = suite.plan.find((c) => c.id === operation)!;
          const report = await runChecks(
            [action],
            suite.cleanup,
            controller.signal,
            () => {},
          );
          assert.equal(report.state, "cancelled");
          assert.equal(host.state.fullscreen, original);
          assert.deepEqual(suite.checkpoint().mutations, []);
          assert.ok(saved?.mutations.includes(operation));
          host.state.fullscreen = operation === "requestFullscreen";
          const reopened = createSuite({ ...host.context, recovery: saved });
          host.state.fail = true;
          await assert.rejects(
            reopened.prepareResume(new AbortController().signal),
            /fullscreen|Fullscreen/,
          );
          assert.ok(reopened.checkpoint().mutations.includes(operation));
          host.state.fail = false;
          await reopened.prepareResume(new AbortController().signal);
          assert.equal(host.state.fullscreen, original);
          assert.deepEqual(reopened.checkpoint().mutations, []);
        } finally {
          host.client.dispose();
        }
      }
    }
  });
}

test("unknown initial fullscreen state prevents new mutations and never retires old recovery debt", async () => {
  const client = createMiniAppClient({
    id: "unknown-fullscreen",
    launchData: "",
    capabilities: new Set(["fullscreen"]),
    snapshot: () => ({}),
    subscribe: () => () => {},
    execute: async () =>
      assert.fail("Unknown original state cannot be safely changed"),
  });
  const context: SuiteContext = {
    client,
    primary: false,
    runId: id,
    bridgeId: "native",
    consent: null,
    includeBot: false,
    api: async () => {
      throw new Error("unused");
    },
    verified() {},
    observed: () => ({}),
    interact: async () => {
      throw new Error("Must not offer a destructive unknown-state check");
    },
  };
  try {
    const clean = createSuite(context);
    for (const name of ["requestFullscreen", "exitFullscreen"])
      assert.equal(
        clean.plan.find((c) => c.id === name)!.skip?.()?.state,
        "manual",
      );
    const interrupted = createSuite({
      ...context,
      recovery: {
        key: `lo-sdk-run-${id}-native`,
        written: [],
        mutations: ["exitFullscreen"],
        original: {},
      },
    });
    await assert.rejects(
      interrupted.cleanup.execute(new AbortController().signal),
      /исходное состояние неизвестно/,
    );
    assert.deepEqual(interrupted.checkpoint().mutations, ["exitFullscreen"]);
  } finally {
    client.dispose();
  }
});

test("missing bridge cannot silently retire persisted button recovery", async () => {
  const suite = createSuite({
    client: null,
    primary: false,
    runId: id,
    bridgeId: "native",
    consent: null,
    includeBot: false,
    api: async () => {
      throw new Error("unused");
    },
    verified() {},
    observed: () => ({}),
    recovery: {
      key: `lo-sdk-run-${id}-native`,
      written: [],
      mutations: ["setButton"],
      original: {},
    },
  });
  await assert.rejects(
    suite.prepareResume(new AbortController().signal),
    /setButton/,
  );
  assert.deepEqual(suite.checkpoint().mutations, ["setButton"]);
});

test("button checkpoints retain only unconfirmed targets when capabilities disappear, including old aggregate debt", async () => {
  const host = recoveryHost("compat");
  const limited = createMiniAppClient({
    ...host.client.adapter,
    capabilities: new Set<Capability>(["mainButton"]),
  });
  const original = {
    key: `lo-sdk-run-${id}-compat`,
    written: [],
    mutations: ["setButton"],
    buttons: ["main", "secondary"] as ("main" | "secondary")[],
    original: {},
  };
  try {
    const suite = createSuite({
      ...host.context,
      client: limited,
      recovery: original,
    });
    await assert.rejects(
      suite.cleanup.execute(new AbortController().signal),
      /secondary/,
    );
    assert.deepEqual(suite.checkpoint().buttons, ["secondary"]);
    assert.deepEqual(suite.checkpoint().mutations, ["setButton"]);
    const restored = report();
    restored.recovery = { compat: suite.checkpoint() };
    const store = storage();
    saveRun(store, restored, "fixture", dependencies);
    assert.deepEqual(readRun(store, dependencies)?.recovery, restored.recovery);
    const reopened = createSuite({
      ...host.context,
      recovery: readRun(store, dependencies)!.recovery!.compat,
    });
    await reopened.prepareResume(new AbortController().signal);
    assert.deepEqual(reopened.checkpoint().mutations, []);
    assert.equal(reopened.checkpoint().buttons, undefined);

    const { buttons: _buttons, ...legacy } = original;
    const old = createSuite({
      ...host.context,
      client: limited,
      recovery: legacy,
    });
    await assert.rejects(
      old.cleanup.execute(new AbortController().signal),
      /secondary.*back.*settings/,
    );
    assert.deepEqual(old.checkpoint().buttons, [
      "secondary",
      "back",
      "settings",
    ]);
    assert.deepEqual(old.checkpoint().mutations, ["setButton"]);
  } finally {
    limited.dispose();
    host.client.dispose();
  }
});
