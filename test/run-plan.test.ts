import assert from "node:assert/strict";
import test from "node:test";
import { orderRunPlan } from "../web/run-plan.ts";
import {
  matchesPlan,
  runChecks,
  type Check,
  type CheckResult,
  type RunReport,
} from "../web/runner.ts";
import { createSuite } from "../web/suite.ts";
import { canRunDeferred } from "../web/deferred.ts";

const check = (
  id: string,
  execute: Check["execute"] = async () => "ok",
): Check => ({ id, label: id, group: "fixture", execute });
const saved = (id: string, state: CheckResult["state"]): CheckResult => ({
  id,
  label: id,
  group: "fixture",
  state,
  detail: "retained",
  durationMs: 7,
});

test("automatic checks precede assisted work while native producer chains keep their order", async () => {
  const order: string[] = [];
  const ids = [
    "server",
    "signature",
    "native:requestWriteAccess",
    "audio-context",
    "native:haptic",
    "native:startAccelerometer",
    "native:stopAccelerometer",
    "native:cloudStorageSet",
    "native:cloudStorageGet",
    "bot:getIdentity",
    "bot:sendMessage",
    "bot:editMessage",
    "native:event:themeChanged",
    "bot:delivery",
  ];
  const plan = orderRunPlan(
    ids.map((id) =>
      check(id, async () => {
        order.push(id);
        return "ok";
      }),
    ),
  );
  const firstAssisted = plan.findIndex((item) => item.phase === "assisted");
  assert.ok(
    plan.slice(0, firstAssisted).every((item) => item.phase === "automatic"),
  );
  assert.ok(
    plan.slice(firstAssisted).every((item) => item.phase !== "automatic"),
  );
  for (const [before, after] of [
    ["server", "signature"],
    ["native:startAccelerometer", "native:stopAccelerometer"],
    ["native:cloudStorageSet", "native:cloudStorageGet"],
    ["native:requestWriteAccess", "bot:sendMessage"],
    ["bot:sendMessage", "bot:editMessage"],
    ["native:haptic", "native:event:themeChanged"],
    ["bot:sendMessage", "bot:delivery"],
  ])
    assert.ok(
      plan.findIndex((item) => item.id === before) <
        plan.findIndex((item) => item.id === after),
    );
  await runChecks(
    plan,
    check("cleanup"),
    new AbortController().signal,
    () => {},
  );
  assert.equal(order.includes("native:haptic"), true);
});

test("native reports resume without replaying completed effects, and changed plan identity is rejected", async () => {
  const old: RunReport = {
    id: "old",
    state: "cancelled",
    startedAt: new Date().toISOString(),
    suiteRevision: 1,
    checks: [
      saved("native:haptic", "passed"),
      saved("native:ready", "cancelled"),
      saved("cleanup", "passed"),
    ],
  };
  let calls = 0;
  const plan = orderRunPlan(
    [
      check("native:haptic", async () => {
        assert.fail("Completed effect must not replay");
      }),
      check("native:ready", async () => {
        calls++;
        return "fresh";
      }),
    ],
    old.checks,
  );
  assert.equal(matchesPlan(old, [...plan, check("cleanup")]), true);
  for (const changed of [
    plan.map((item) => ({ ...item, label: item.label + "changed" })),
    [plan[0], plan[0]],
    plan.map((item) => ({ ...item, bridge: "different" })),
  ])
    assert.equal(matchesPlan(old, [...changed, check("cleanup")]), false);
  const report = await runChecks(
    plan,
    check("cleanup"),
    new AbortController().signal,
    () => {},
    12000,
    { previous: old },
  );
  assert.equal(calls, 1);
  assert.equal(
    report.checks.find((item) => item.id === "native:haptic")!.detail,
    "retained",
  );
  assert.equal(
    report.checks.find((item) => item.id === "native:haptic")!.durationMs,
    7,
  );
});

test("historical compatibility end actions cannot run and interrupted bot reads require assistance", () => {
  const plan = orderRunPlan(
    [
      check("native:system-theme"),
      check("native:close"),
      check("bot:getCommands"),
    ],
    [{ ...saved("bot:getCommands", "cancelled"), interrupted: true }],
  );
  assert.equal(
    plan.find((item) => item.id === "bot:getCommands")!.phase,
    "assisted",
  );
  const owner = { appId: "app", userId: "user" };
  const report: RunReport = {
    id: "fixture",
    startedAt: new Date().toISOString(),
    state: "finished",
    owner,
    checks: [
      saved("native:close", "manual"),
      saved("compat:close", "manual"),
      saved("cleanup", "passed"),
    ],
  };
  assert.equal(canRunDeferred(report, "compat:close", owner), false);
  assert.equal(canRunDeferred(report, "native:close", owner), true);
});

test("resume preparation never asks permission, and unfinished bot work obtains fresh consent lazily once", async () => {
  let grants = 0,
    sends = 0;
  const previous = [
    saved("requestWriteAccess", "passed"),
    saved("bot:sendMessage", "cancelled"),
    saved("bot:editMessage", "cancelled"),
  ];
  const suite = createSuite({
    client: {
      adapter: { launchData: "signed", snapshot: () => ({}) },
      supports: () => true,
    } as never,
    consent: null,
    includeBot: true,
    resumeChecks: previous,
    observed: () => ({}),
    verified: () => {},
    writeAccess: async () => {
      grants++;
      return { allowed: true };
    },
    api: async <T>(path: string) => {
      if (path === "status")
        return { appConfigured: true, botConfigured: true } as T;
      if (path === "session")
        return {
          verified: true,
          resources: { message: false, files: [], metadata: false },
        } as T;
      if (path === "bot") {
        sends++;
        return { mode: "live", result: true } as T;
      }
      return {} as T;
    },
  });
  const signal = new AbortController().signal;
  await suite.prepareResume(signal);
  assert.equal(grants, 0);
  const send = suite.plan.find((item) => item.id === "bot:sendMessage")!;
  assert.equal(send.skip?.(), undefined);
  await send.execute(signal);
  assert.equal(grants, 1);
  assert.equal(sends, 1);
  await suite.plan
    .find((item) => item.id === "bot:editMessage")!
    .execute(signal);
  assert.equal(grants, 1);
});

for (const mode of ["skip", "deny", "error", "abort"] as const) {
  test(`resumed authorization ${mode} never sends or requests consent again`, async () => {
    let grants = 0,
      sends = 0;
    const controller = new AbortController();
    const suite = createSuite({
      client: {
        adapter: { launchData: "signed", snapshot: () => ({}) },
        supports: () => true,
      } as never,
      consent: null,
      includeBot: true,
      resumeChecks: [
        saved("requestWriteAccess", "passed"),
        saved("bot:sendMessage", "cancelled"),
      ],
      observed: () => ({}),
      verified: () => {},
      writeAccess: async () => {
        grants++;
        if (mode === "error")
          return { allowed: false, error: "denied transport" };
        if (mode === "abort") {
          controller.abort();
          controller.signal.throwIfAborted();
        }
        return { allowed: false, skipped: mode === "skip" };
      },
      api: async <T>(path: string) => {
        if (path === "status")
          return { appConfigured: true, botConfigured: true } as T;
        if (path === "session")
          return {
            verified: true,
            resources: { message: false, files: [], metadata: false },
          } as T;
        if (path === "bot") {
          sends++;
          return { mode: "live", result: true } as T;
        }
        return {} as T;
      },
    });
    await suite.prepareResume(controller.signal);
    const send = suite.plan.find((item) => item.id === "bot:sendMessage")!;
    assert.equal(send.timeoutMs, 180000);
    assert.equal(send.timeoutState, "manual");
    if (mode === "skip")
      assert.equal(
        ((await send.execute(controller.signal)) as CheckResult).state,
        "manual",
      );
    else await assert.rejects(() => send.execute(controller.signal));
    assert.equal(grants, 1);
    assert.equal(sends, 0);
    assert.ok(
      suite.plan.find((item) => item.id === "bot:editMessage")!.skip?.(),
    );
  });
}
