import test from "node:test";
import assert from "node:assert/strict";
import type { MiniAppClient } from "@lo-ink/miniapp-sdk";
import { beginAudio } from "../web/audio.ts";
import {
  createInteraction,
  type InteractionView,
  type Interact,
} from "../web/interaction.ts";
import { guidedBridgeCheck } from "../web/bridge-checks.ts";
import { bridgeCoverage, runChecks, type RunReport } from "../web/runner.ts";
import { createSuite } from "../web/suite.ts";
import { availableBridges } from "../web/bridges.ts";
import { operationNames } from "../web/cases.ts";
import { createMiniAppClient } from "@lo-ink/miniapp-sdk";
import { createWebAppAdapter } from "@lo-ink/adapter-webapp-compat";
const signal = () => new AbortController().signal;
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const client = (call: (...args: any[]) => Promise<any>, snapshot = {}) =>
  ({
    call,
    supports: () => true,
    adapter: { snapshot: () => snapshot, launchData: "synthetic" },
    on: () => () => {},
  }) as unknown as MiniAppClient;
const suite = (value: MiniAppClient | null, overrides = {}) =>
  createSuite({
    client: value,
    api: async () => {
      throw new Error("unused");
    },
    consent: null,
    includeBot: false,
    verified: () => {},
    observed: () => ({}),
    ...overrides,
  });

test("interaction starts a native call synchronously from the action and requires an answer after it finishes", async () => {
  let view: InteractionView | null = null,
    calls = 0;
  const request = createInteraction((next) => {
    view = next;
  });
  const result = request(
    {
      title: "haptic",
      detail: "test",
      question: "felt?",
      action: async () => {
        calls++;
        return "ack";
      },
    },
    signal(),
  );
  view!.answer("yes");
  assert.equal(calls, 0);
  view!.start("");
  assert.equal(calls, 1);
  view!.start("");
  assert.equal(calls, 1);
  await tick();
  assert.equal(view!.phase, "confirm");
  view!.answer("no");
  assert.deepEqual(await result, { decision: "no", value: "ack" });
  assert.equal(view, null);
});

test("skip never invokes the native action; stop releases a waiting question and a late answer cannot confirm it", async () => {
  let view: InteractionView | null = null;
  const request = createInteraction((next) => {
    view = next;
  });
  const result = request(
    {
      title: "clear",
      detail: "test",
      action: async () => assert.fail("must not clear"),
    },
    signal(),
  );
  view!.answer("skip");
  assert.equal((await result).decision, "skip");
  const controller = new AbortController();
  const stopped = request(
    { title: "effect", detail: "test" },
    controller.signal,
  );
  const stale = view!;
  controller.abort();
  stale.answer("yes");
  await assert.rejects(stopped);
  assert.equal(view, null);
});

test("repeat invokes the action again and only its latest result can be confirmed", async () => {
  let view: InteractionView | null = null;
  const pending: ((value: string) => void)[] = [];
  const request = createInteraction((next) => {
    view = next;
  });
  const result = request(
    {
      title: "repeat",
      detail: "test",
      question: "seen?",
      action: () => new Promise<string>((resolve) => pending.push(resolve)),
    },
    signal(),
  );
  view!.start("");
  pending[0]("first");
  await tick();
  assert.equal(view!.phase, "confirm");
  view!.repeat("");
  assert.equal(view!.phase, "busy");
  assert.equal(view!.attempt, 2);
  view!.start("");
  view!.answer("yes");
  assert.equal(pending.length, 2);
  assert.equal(view!.phase, "busy");
  pending[1]("second");
  await tick();
  view!.answer("yes");
  assert.deepEqual(await result, { decision: "yes", value: "second" });
});

test("repeat with an input restores preparation before invoking the bridge again", async () => {
  let view: InteractionView | null = null;
  const calls: string[] = [];
  const request = createInteraction((next) => {
    view = next;
  });
  const result = request(
    {
      title: "hide keyboard",
      detail: "open the keyboard first",
      input: { label: "keyboard", value: "first" },
      question: "hidden?",
      action: async (text) => {
        calls.push(text);
        return text;
      },
    },
    signal(),
  );
  view!.start("first");
  await tick();
  assert.equal(view!.phase, "confirm");
  view!.repeat("first");
  assert.equal(view!.phase, "ready");
  assert.equal(view!.attempt, 1);
  assert.deepEqual(calls, ["first"]);
  view!.answer("yes");
  assert.equal(view!.phase, "ready");
  view!.start("second");
  assert.deepEqual(calls, ["first", "second"]);
  await tick();
  assert.equal(view!.attempt, 2);
  view!.answer("yes");
  assert.deepEqual(await result, { decision: "yes", value: "second" });
});

test("an already expanded panel still calls each bridge without claiming a visible change", async () => {
  const calls: string[] = [];
  const adapter = client(async (name) => calls.push(name));
  const result = await guidedBridgeCheck(
    "expand",
    {
      client: adapter,
      observed: () => ({}),
      panelExpanded: () => true,
      interact: async () =>
        assert.fail("cannot ask to observe an impossible change"),
    },
    signal(),
  );
  assert.deepEqual(calls, ["expand"]);
  assert.equal(result.state, "manual");
  assert.match(result.detail!, /уже развёрнута/);
  await assert.rejects(
    guidedBridgeCheck(
      "expand",
      {
        client: client(async () => {
          throw new Error("bridge failure");
        }),
        observed: () => ({}),
        panelExpanded: () => true,
        interact: async () => assert.fail("must not ask"),
      },
      signal(),
    ),
    /bridge failure/,
  );
});

test("an unexpanded panel cannot pass expand when the user saw no increase", async () => {
  let calls = 0;
  await assert.rejects(
    guidedBridgeCheck(
      "expand",
      {
        client: client(async () => {
          calls++;
        }),
        observed: () => ({}),
        panelExpanded: () => false,
        interact: async (prompt) => {
          assert.match(prompt.question!, /стала выше/);
          await prompt.action!("");
          return { decision: "no" };
        },
      },
      signal(),
    ),
    /не подтвердил/,
  );
  assert.equal(calls, 1);
});

test("haptic API acknowledgement cannot become a pass without device confirmation", async () => {
  const calls: string[] = [];
  const adapter = client(async (name) => {
    calls.push(name);
  });
  const skip: Interact = async () => ({ decision: "skip" });
  const result = await guidedBridgeCheck(
    "haptic",
    { client: adapter, interact: skip, observed: () => ({}) },
    signal(),
  );
  assert.equal(result.state, "manual");
  assert.deepEqual(calls, []);
  const no: Interact = async (prompt) => {
    await prompt.action!("");
    return { decision: "no" };
  };
  await assert.rejects(
    guidedBridgeCheck(
      "haptic",
      { client: adapter, interact: no, observed: () => ({}) },
      signal(),
    ),
    /не подтвердил/,
  );
  assert.deepEqual(calls, ["haptic", "haptic", "haptic"]);
});

test("colour check restores the actual previous colour and releases the theme guard after cancellation", async () => {
  const controller = new AbortController(),
    colours: string[] = [],
    guards: boolean[] = [];
  const adapter = client(
    async (_name, input, options) => {
      colours.push(input.color);
      assert.equal(options.signal.aborted, false);
    },
    { theme: { headerBackground: "#123456" } },
  );
  const interact: Interact = async (prompt) => {
    const work = prompt.action!("");
    await tick();
    controller.abort();
    await work;
    return { decision: "yes" };
  };
  await assert.rejects(
    guidedBridgeCheck(
      "setHeaderColor",
      {
        client: adapter,
        interact,
        observed: () => ({}),
        appearanceGuard: (value) => guards.push(value),
      },
      controller.signal,
    ),
  );
  assert.deepEqual(colours, ["#e87820", "#123456"]);
  assert.deepEqual(guards, [true, false]);
});

test("button confirmation requires a fresh bridge event; cleanup hides only a button that was shown", async () => {
  const calls: unknown[] = [];
  const adapter = client(async (_name, input) => {
    calls.push(input);
  });
  const yes: Interact = async (prompt) => {
    await prompt.action!("");
    return { decision: "yes" };
  };
  await assert.rejects(
    guidedBridgeCheck(
      "setButton",
      {
        client: adapter,
        interact: yes,
        observed: () => ({ mainButtonClicked: "old" }),
      },
      signal(),
    ),
    /не подтверждено событием/,
  );
  assert.equal((calls[1] as any).params.visible, false);
  calls.length = 0;
  await guidedBridgeCheck(
    "setButton",
    {
      client: adapter,
      interact: async () => ({ decision: "skip" }),
      observed: () => ({}),
    },
    signal(),
  );
  assert.deepEqual(calls, []);
});

test("back and settings checks work through the compatible bridge without text or active setters", async () => {
  for (const button of ["back", "settings"] as const) {
    const visibility: boolean[] = [];
    const observed: Record<string, string> = {};
    const sdk = createMiniAppClient(
      createWebAppAdapter(
        "compat-test",
        {
          [button === "back" ? "BackButton" : "SettingsButton"]: {
            show: () => visibility.push(true),
            hide: () => visibility.push(false),
          },
        },
        new Set([button === "back" ? "backButton" : "settingsButton"]),
      ),
    );
    const check = suite(sdk, {
      observed: () => observed,
      interact: async (prompt: any) => {
        await prompt.action("");
        observed[`${button}ButtonClicked`] = "fresh";
        return { decision: "yes" };
      },
    }).plan.find((check) => check.id === `button:${button}`)!;
    const result = await check.execute(signal());
    assert.equal((result as any).state, "passed");
    assert.deepEqual(visibility, [true, false]);
  }
});

test("sensor start acknowledgement without a fresh finite sample fails rather than passing", async () => {
  let subscriber: ((payload: unknown) => void) | undefined,
    released = false;
  const adapter = client(async () => {
    subscriber!({ x: NaN, y: 0, z: 0 });
    return true;
  });
  adapter.on = ((_event: string, listener: (payload: unknown) => void) => {
    subscriber = listener;
    return () => {
      released = true;
    };
  }) as any;
  await assert.rejects(
    guidedBridgeCheck(
      "startAccelerometer",
      {
        client: adapter,
        interact: async () => ({ decision: "skip" }),
        observed: () => ({}),
      },
      signal(),
    ),
    /корректные данные/,
  );
  assert.equal(released, true);
});

test("sensor scenarios use LO's valid millisecond interval and require actual samples", async () => {
  for (const operation of [
    "startAccelerometer",
    "startGyroscope",
    "startDeviceOrientation",
  ] as const) {
    let subscriber: ((payload: unknown) => void) | undefined;
    const adapter = client(async (_name, input) => {
      // LO's native wire rejects intervals outside 20–1000 ms.
      assert.ok(
        Number.isInteger(input.refreshRate) &&
          input.refreshRate >= 20 &&
          input.refreshRate <= 1000,
      );
      subscriber!(
        operation === "startDeviceOrientation"
          ? { alpha: 1, beta: 2, gamma: 3 }
          : { x: 1, y: 2, z: 3 },
      );
      return true;
    });
    adapter.on = ((_event: string, listener: (payload: unknown) => void) => {
      subscriber = listener;
      return () => {};
    }) as any;
    const result = await guidedBridgeCheck(
      operation,
      {
        client: adapter,
        interact: async () => ({ decision: "skip" }),
        observed: () => ({}),
      },
      signal(),
    );
    assert.equal(result.state, "passed");
    assert.equal(result.evidence, "data");
  }
});

test("sensor refusal is unverified only with a fresh explicit unavailable event", async () => {
  for (const [operation, failedEvent] of [
    ["startAccelerometer", "accelerometerFailed"],
    ["startGyroscope", "gyroscopeFailed"],
    ["startDeviceOrientation", "orientationFailed"],
  ] as const) {
    for (const reason of ["UNSUPPORTED", "INTERNAL_ERROR", undefined]) {
      const listeners = new Map<string, (value: unknown) => void>();
      const adapter = client(async () => {
        if (reason !== undefined) listeners.get(failedEvent)!({ reason });
        return false;
      });
      adapter.on = ((event: string, listener: (value: unknown) => void) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      }) as any;
      const result = guidedBridgeCheck(
        operation,
        {
          client: adapter,
          interact: async () => ({ decision: "skip" }),
          observed: () => ({ [failedEvent]: "old UNSUPPORTED event" }),
        },
        signal(),
      );
      if (reason === "UNSUPPORTED") {
        const outcome = await result;
        assert.equal(outcome.state, "manual");
        assert.equal(outcome.evidence, undefined);
      } else await assert.rejects(result, /не запустил/);
      assert.equal(listeners.size, 0);
    }
  }
});

test("clipboard null is unverified, while wrong or malformed content remains a failure", async () => {
  for (const value of [null, "", "different text", undefined, "LO SDK Test"]) {
    let called = false;
    const result = guidedBridgeCheck(
      "readClipboard",
      {
        client: client(async () => {
          called = true;
          return value;
        }),
        interact: async (prompt) => ({
          decision: "yes",
          value: await prompt.action!(""),
        }),
        observed: () => ({}),
      },
      signal(),
    );
    if (value === null) {
      const outcome = await result;
      assert.equal(outcome.state, "manual");
      assert.equal(outcome.evidence, undefined);
    } else if (value === "LO SDK Test") {
      assert.equal((await result).state, "passed");
    } else await assert.rejects(result, /не вернул скопированный/);
    assert.equal(called, true);
  }
});

test("biometry cleanup preserves successful and uncertain writes but excludes definite refusals", async () => {
  for (const writes of [[false], [true], [true, false], ["throw"]] as const) {
    let index = 0;
    let removals = 0;
    const adapter = client(async (operation, input) => {
      if (operation === "getBiometryInfo") return { tokenSaved: true };
      assert.equal(operation, "updateBiometryToken");
      if (input.token === "") {
        removals++;
        return false;
      }
      const result = writes[index++];
      if (result === "throw") throw new Error("response lost after write");
      return result;
    });
    const checks = suite(adapter, {
      interact: async (prompt: any) => {
        let value: unknown;
        for (const _ of writes) value = await prompt.action("");
        return { decision: "yes", value };
      },
    });
    const report = await runChecks(
      checks.plan.filter((check) => check.id === "updateBiometryToken"),
      checks.cleanup,
      signal(),
      () => {},
    );
    if (writes.length === 1 && writes[0] === false) {
      assert.equal(report.checks[0].state, "manual");
      assert.equal(report.checks[1].state, "skipped");
      assert.equal(removals, 0);
    } else {
      assert.equal(report.checks[1].state, "failed");
      assert.match(report.checks[1].detail, /updateBiometryToken/);
      assert.equal(removals, 1);
    }
  }
});

test("audio start evidence is captured before LO's later permission deactivation", async () => {
  let state: AudioContextState = "suspended";
  const context = {
    get state() {
      return state;
    },
    resume: () => {
      state = "running";
      return Promise.resolve();
    },
  };
  const started = beginAudio(context);
  await started;
  state = "suspended";
  const check = suite(null, {
    audioStarted: started,
    audioState: () => state,
  }).plan.find((item) => item.id === "audio-context")!;
  assert.match((await check.execute(signal())) as string, /непосредственно/);
});

test("all supported SDK methods are runnable in the same guided flow; only closing actions are deferred", () => {
  const adapter = client(async () => true);
  const plan = suite(adapter, {
    interact: async () => ({ decision: "skip" }),
  }).plan;
  for (const operation of operationNames) {
    if (operation === "requestWriteAccess") continue;
    const skip = plan.find((item) => item.id === operation)!.skip?.();
    if (operation === "close" || operation === "sendData")
      assert.equal(skip?.state, "manual");
    else if (
      /Storage(Get|Keys|Remove)/.test(operation) ||
      operation.startsWith("stop")
    )
      assert.ok(skip, "dependency is explicitly unverified before setup");
    else assert.equal(skip, undefined, operation);
  }
});

test("cloud key enumeration checks before and after removal; an empty-result host failure stays visible", async () => {
  for (const failEmpty of [false, true]) {
    const values = new Map<string, string>(),
      calls: string[] = [];
    const adapter = client(async (name, input) => {
      calls.push(name);
      if (name === "cloudStorageSet") {
        values.set(input.key, input.value);
        return true;
      }
      if (name === "cloudStorageGet") return values.get(input.key) ?? null;
      if (name === "cloudStorageKeys") {
        if (!values.size && failEmpty)
          throw new Error("empty keys host failure");
        return [...values.keys()];
      }
      if (name === "cloudStorageRemove") {
        values.delete(input.key);
        return true;
      }
      return null;
    });
    const value = suite(adapter);
    const report = await runChecks(
      value.plan.filter((item) =>
        ["cloudStorageSet", "cloudStorageKeys"].includes(item.id),
      ),
      value.cleanup,
      signal(),
      () => {},
    );
    assert.equal(
      report.checks.find((item) => item.id === "cloudStorageKeys")!.state,
      failEmpty ? "failed" : "passed",
    );
    assert.equal(values.size, 0);
    assert.equal(calls.filter((name) => name === "cloudStorageKeys").length, 2);
  }
});

test("coverage includes unverified methods and events; response-only and synthetic checks cannot inflate it", async () => {
  const report = await runChecks(
    [
      {
        id: "native:haptic",
        label: "haptic",
        group: "bridge",
        bridge: "native",
        execute: async () => ({ state: "manual", detail: "not felt" }),
      },
      {
        id: "native:colour",
        label: "colour",
        group: "bridge",
        bridge: "native",
        execute: async () => ({
          state: "passed",
          evidence: "device",
          detail: "seen",
        }),
      },
      {
        id: "native:event:mainButtonClicked",
        label: "event",
        group: "events",
        bridge: "native",
        execute: async () => ({ state: "manual", detail: "not received" }),
      },
      {
        id: "native:wire",
        label: "wire",
        group: "bridge",
        bridge: "native",
        evidence: "response",
        execute: async () => "ack",
      },
      {
        id: "native:synthetic",
        label: "synthetic with bridge",
        group: "synthetic",
        bridge: "native",
        evidence: "synthetic",
        execute: async () => "expected error",
      },
      {
        id: "native:unspecified",
        label: "unspecified evidence",
        group: "bridge",
        bridge: "native",
        execute: async () => "ack",
      },
      {
        id: "errors:0",
        label: "synthetic",
        group: "synthetic",
        evidence: "synthetic",
        execute: async () => "expected error",
      },
    ],
    {
      id: "cleanup",
      label: "cleanup",
      group: "test",
      execute: async () => "clean",
    },
    signal(),
    () => {},
  );
  assert.deepEqual(bridgeCoverage(report), [
    { bridge: "native", confirmed: 1, total: 6, percent: 16 },
  ]);
  assert.equal(report.checks[0].state, "manual");
});

test("cloud enumeration respects the listener refill budget across every internal step and cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const values = new Map<string, string>();
  const times: number[] = [];
  const sdk = client(async (name, input) => {
    const now = Date.now();
    if (times.length && now - times.at(-1)! < 1000)
      throw new Error("STORAGE_QUOTA_EXCEEDED");
    times.push(now);
    if (name === "cloudStorageSet") values.set(input.key, input.value);
    if (name === "cloudStorageGet") return values.get(input.key) ?? null;
    if (name === "cloudStorageKeys") return [...values.keys()];
    if (name === "cloudStorageRemove") values.delete(input.key);
    return true;
  });
  const { plan, cleanup } = suite(sdk);
  const execute = async (check: (typeof plan)[number]) => {
    let settled = false;
    const pending = check.execute(signal()).finally(() => {
      settled = true;
    });
    // Keep the rejection handled while advancing the deliberately paced call.
    pending.catch(() => {});
    for (let i = 0; !settled && i < 30; i++) {
      await tick();
      t.mock.timers.tick(1100);
    }
    return pending;
  };
  await execute(plan.find((check) => check.id === "cloudStorageSet")!);
  await execute(plan.find((check) => check.id === "cloudStorageKeys")!);
  await execute(cleanup);
  assert.equal(values.size, 0);
  assert.equal(times.length, 7);
});

test("legacy discovery stays separate without a native adapter", () => {
  const scope = {
    LO: {
      WebApp: { initData: "synthetic", capabilities: ["ready"], ready() {} },
    },
  };
  const bridges = availableBridges(scope);
  assert.equal(bridges[0].client, null);
  assert.equal(bridges[1].client?.adapter.id, "lo-legacy-webapp");
});

test("bot pacing waits after the actual interactive request even when the user takes time to press", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const calls: Array<{ operation: string; time: number }> = [];
  const { plan } = suite(
    client(async () => true),
    {
      consent: true,
      includeBot: true,
      api: async (path: string, body: any) => {
        if (path === "status")
          return { appConfigured: true, botConfigured: true };
        if (path === "session") return { verified: true };
        if (path === "consent") return {};
        calls.push({ operation: body.operation, time: Date.now() });
        t.mock.timers.tick(300);
        return { mode: "live", result: true };
      },
      interact: async (request: any) => {
        t.mock.timers.tick(5000);
        return { decision: "yes", value: await request.action() };
      },
    },
  );
  for (const id of ["server", "signature", "bot:setCommands"])
    await plan.find((check) => check.id === id)!.execute(signal());
  const menu = plan
    .find((check) => check.id === "bot:setChatMenuButton")!
    .execute(signal());
  await tick();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(2299);
  await tick();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await menu;
  assert.equal(calls[1].operation, "setChatMenuButton");
  assert.ok(calls[1].time - calls[0].time >= 2600);
});

test("flag cases require both device effects and restore independently on success, skip, failure and abort", async () => {
  for (const operation of [
    "setOrientationLock",
    "setVerticalSwipes",
  ] as const) {
    for (const ending of ["yes", "skip", "no", "abort"] as const) {
      const controller = new AbortController();
      const calls: { value: boolean; signal: AbortSignal }[] = [];
      const sdk = client(
        async (_name, input, options) => {
          calls.push({
            value: input.locked ?? input.enabled,
            signal: options.signal,
          });
        },
        { isOrientationLocked: true },
      );
      let phase = 0;
      const work = guidedBridgeCheck(
        operation,
        {
          client: sdk,
          observed: () => ({}),
          interact: async (request) => {
            phase++;
            await request.action!("");
            if (phase === 2 && ending === "abort") {
              controller.abort();
              throw new Error("aborted");
            }
            return {
              decision:
                phase === 2 ? (ending === "abort" ? "skip" : ending) : "yes",
            };
          },
        },
        controller.signal,
      );
      if (ending === "no" || ending === "abort") await assert.rejects(work);
      else
        assert.equal(
          (await work).state,
          ending === "yes" ? "passed" : "manual",
        );
      assert.deepEqual(
        calls.map((call) => call.value),
        operation === "setOrientationLock"
          ? ending === "yes"
            ? [false, true, false, true]
            : [false, true, true]
          : ending === "yes"
            ? [true, false, true, true]
            : [true, false, true],
      );
      assert.notEqual(calls.at(-1)!.signal, controller.signal);
      assert.equal(calls.at(-1)!.signal.aborted, false);
    }
  }
});

test("no flag ACK alone passes and fullscreen gestures remain unverified", async () => {
  let calls = 0;
  const sdk = client(async () => {
    calls++;
  });
  for (const name of [
    "setOrientationLock",
    "setVerticalSwipes",
    "setClosingConfirmation",
  ] as const) {
    const outcome = await guidedBridgeCheck(
      name,
      {
        client: sdk,
        observed: () => ({}),
        interact: async (request) => {
          await request.action!("");
          return { decision: "skip" };
        },
      },
      signal(),
    );
    assert.equal(outcome.state, "manual");
  }
  const before = calls;
  const result = await guidedBridgeCheck(
    "setVerticalSwipes",
    {
      client: client(
        async () => {
          calls++;
        },
        { isFullscreen: true },
      ),
      observed: () => ({}),
      interact: async () =>
        assert.fail("No valid gesture observation in fullscreen"),
    },
    signal(),
  );
  assert.equal(result.state, "manual");
  assert.equal(calls, before);
});

test("closing confirmation is reset, freshly enabled, then disabled even when the device confirmation fails", async () => {
  const values: boolean[] = [];
  await assert.rejects(
    guidedBridgeCheck(
      "setClosingConfirmation",
      {
        client: client(async (_name, input) => {
          values.push(input.enabled);
        }),
        observed: () => ({}),
        interact: async (request) => {
          await request.action!("");
          return { decision: "no" };
        },
      },
      signal(),
    ),
  );
  assert.deepEqual(values, [false, true, false]);
});

test("two bridge orientation cases each start from restored state instead of the preceding bridge lock", async () => {
  let locked = false;
  const observations: boolean[] = [];
  const make = () =>
    createSuite({
      client: client(async (_name, input) => {
        locked = input.locked;
      }),
      api: async () => {
        throw new Error("unused");
      },
      consent: null,
      includeBot: false,
      verified: () => {},
      observed: () => ({}),
      interact: async (request) => {
        await request.action!("");
        observations.push(locked);
        return { decision: "yes" };
      },
    });
  const first = make(),
    second = make();
  const firstCase = first.plan.find(
    (check) => check.id === "setOrientationLock",
  )!;
  const secondCase = second.plan.find(
    (check) => check.id === "setOrientationLock",
  )!;
  const startStates: boolean[] = [];
  for (const value of [firstCase, secondCase]) {
    const execute = value.execute;
    value.execute = async (signal) => {
      startStates.push(locked);
      return execute(signal);
    };
  }
  const report = await runChecks(
    [firstCase, secondCase],
    {
      id: "cleanup",
      label: "cleanup",
      group: "test",
      execute: async () => "done",
    },
    signal(),
    () => {},
  );
  assert.deepEqual(startStates, [false, false]);
  assert.deepEqual(observations, [false, true, false, false, true, false]);
  assert.equal(
    report.checks.every((check) => check.state === "passed"),
    true,
  );
  assert.equal(locked, false);
});

test("a refused orientation restore stops the next bridge and aggregate cleanup retries with a fresh signal", async () => {
  const values: boolean[] = [];
  const sdk = client(
    async (_name, input, options) => {
      assert.equal(options.signal.aborted, false);
      values.push(input.locked);
      return values.length === 4 ? false : undefined;
    },
    { isOrientationLocked: false },
  );
  const checks = suite(sdk, {
    interact: async (request: Parameters<Interact>[0]) => {
      await request.action!("");
      return { decision: "yes" };
    },
  });
  const orientation = checks.plan.find(
    (check) => check.id === "setOrientationLock",
  )!;
  const report = await runChecks(
    [
      orientation,
      {
        id: "compat",
        label: "compat",
        group: "test",
        execute: async () => assert.fail("leaked state"),
      },
    ],
    checks.cleanup,
    signal(),
    () => {},
  );
  assert.deepEqual(values, [false, true, false, false, false]);
  assert.equal(report.checks[0].state, "failed");
  assert.equal(report.checks[1].state, "cancelled");
  assert.equal(report.checks[2].state, "passed");
});

test("late baseline ACK after timeout cannot apply the next flag mutation after cleanup", async () => {
  const values: boolean[] = [];
  let release: () => void = () => {};
  const sdk = client(async (_name, input) => {
    values.push(input.enabled);
    if (values.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  });
  const checks = suite(sdk, {
    interact: async (request: Parameters<Interact>[0]) => {
      await request.action!("");
      return { decision: "yes" };
    },
  });
  const closing = checks.plan.find(
    (check) => check.id === "setClosingConfirmation",
  )!;
  closing.timeoutMs = 10;
  const report = await runChecks([closing], checks.cleanup, signal(), () => {});
  assert.equal(report.checks[0].state, "manual");
  assert.deepEqual(values, [false, false, false]);
  release();
  await tick();
  assert.equal(values.includes(true), false);
});
