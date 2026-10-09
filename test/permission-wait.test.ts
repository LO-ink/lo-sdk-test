import test from "node:test";
import assert from "node:assert/strict";
import type { MiniAppClient } from "@lo-ink/miniapp-sdk";
import { beginWriteAccess } from "../web/consent.ts";
import { createInteraction, type InteractionView } from "../web/interaction.ts";
import { runChecks } from "../web/runner.ts";
import { createSuite } from "../web/suite.ts";

const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

async function fixture(native: () => Promise<boolean>) {
  let view: InteractionView | null = null;
  const nativeCalls: string[] = [];
  const apiCalls: string[] = [];
  const changed: boolean[] = [];
  const client = {
    adapter: { launchData: "fixture-launch" },
    supports: () => true,
    call: () => {
      nativeCalls.push("requestWriteAccess");
      return native();
    },
  } as unknown as MiniAppClient;
  const interact = createInteraction((next) => {
    view = next;
  });
  const suite = createSuite({
    client,
    consent: null,
    includeBot: true,
    observed: () => ({}),
    verified: () => {},
    consentChanged: (allowed) => changed.push(allowed),
    api: async <T>(path: string) => {
      apiCalls.push(path);
      if (path === "status")
        return { appConfigured: true, botConfigured: true } as T;
      if (path === "session") return { verified: true } as T;
      if (path === "bot") return { mode: "live", result: true } as T;
      return {} as T;
    },
    writeAccess: async (signal) => {
      const answer = await interact(
        {
          title: "Permission",
          detail: "Waiting for a trusted action",
          action: () => beginWriteAccess(client, signal),
        },
        signal,
      );
      return answer.decision === "skip"
        ? { allowed: false, skipped: true }
        : (answer.value as { allowed: boolean; error?: string });
    },
  });
  const signal = new AbortController().signal;
  await suite.plan.find((c) => c.id === "server")!.execute(signal);
  await suite.plan.find((c) => c.id === "signature")!.execute(signal);
  apiCalls.length = 0;
  const controller = new AbortController();
  const result = runChecks(
    suite.plan.filter((c) =>
      ["requestWriteAccess", "bot:sendMessage"].includes(c.id),
    ),
    {
      id: "cleanup",
      label: "Cleanup",
      group: "test",
      execute: async () => "clean",
    },
    controller.signal,
    () => {},
  );
  await drain();
  assert.ok(view);
  return {
    result,
    controller,
    get view() {
      return view;
    },
    nativeCalls,
    apiCalls,
    changed,
  };
}

test("unanswered permission expires as unverified without a native call or bot write", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const f = await fixture(async () => true);
  const stale = f.view!;
  t.mock.timers.tick(60000);
  await drain();
  assert.equal(f.view?.phase, "ready");
  assert.deepEqual(f.nativeCalls, []);
  t.mock.timers.tick(120000);
  const report = await f.result;
  assert.equal(report.checks[0].state, "manual");
  assert.equal(report.checks[1].state, "skipped");
  assert.equal(f.view, null);
  stale.start("");
  stale.answer("yes");
  await drain();
  assert.deepEqual(f.nativeCalls, []);
  assert.deepEqual(f.apiCalls, []);
  assert.deepEqual(f.changed, []);
});

test("a native rejection remains a failed permission check", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const f = await fixture(async () => {
    throw new Error("native rejection");
  });
  f.view!.start("");
  const report = await f.result;
  assert.equal(report.checks[0].state, "failed");
  assert.equal(report.checks[0].detail, "native rejection");
  assert.equal(report.checks[1].state, "skipped");
  assert.deepEqual(f.apiCalls, []);
  assert.deepEqual(f.changed, []);
});

test("the native call still fails after its own sixty-second timeout", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  let finish!: (allowed: boolean) => void;
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.view!.start("");
  await drain();
  t.mock.timers.tick(60000);
  const report = await f.result;
  assert.equal(report.checks[0].state, "failed");
  assert.match(report.checks[0].detail, /60/);
  assert.equal(report.checks[1].state, "skipped");
  finish(true);
  await drain();
  assert.equal(f.view, null);
  assert.deepEqual(f.apiCalls, []);
  assert.deepEqual(f.changed, []);
});

test("outer expiry cancels a late action and ignores its later successful result", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  let finish!: (allowed: boolean) => void;
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  t.mock.timers.tick(179000);
  await drain();
  assert.equal(f.view?.phase, "ready");
  const stale = f.view!;
  stale.start("");
  await drain();
  t.mock.timers.tick(1000);
  const report = await f.result;
  assert.equal(report.checks[0].state, "manual");
  assert.equal(report.checks[1].state, "skipped");
  finish(true);
  stale.start("");
  await drain();
  assert.equal(f.view, null);
  assert.equal(f.nativeCalls.length, 1);
  assert.deepEqual(f.apiCalls, []);
  assert.deepEqual(f.changed, []);
});

test("stop releases ready and busy permission prompts without saving consent", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  for (const start of [false, true]) {
    let finish!: (allowed: boolean) => void;
    const f = await fixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const stale = f.view!;
    if (start) stale.start("");
    f.controller.abort(new Error("stopped"));
    const report = await f.result;
    assert.equal(report.checks[0].state, "cancelled");
    stale.start("");
    if (start) finish(true);
    await drain();
    assert.equal(f.view, null);
    assert.equal(f.nativeCalls.length, Number(start));
    assert.deepEqual(f.apiCalls, []);
    assert.deepEqual(f.changed, []);
  }
});

test("explicit native consent is persisted before the bot action", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const f = await fixture(async () => true);
  f.view!.start("");
  const report = await f.result;
  assert.equal(report.checks[0].state, "passed");
  assert.equal(report.checks[1].state, "passed");
  assert.deepEqual(f.apiCalls, ["consent", "bot"]);
  assert.deepEqual(f.changed, [true]);
});
