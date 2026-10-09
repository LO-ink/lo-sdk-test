import test from "node:test";
import assert from "node:assert/strict";
import { availableBridges } from "../web/bridges.ts";
import { createSuite } from "../web/suite.ts";
import { createInteraction, type InteractionView } from "../web/interaction.ts";
import { runChecks } from "../web/runner.ts";

const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function fixture(
  mode: "success" | "error" | "late" | "unsupported" = "success",
) {
  let view: InteractionView | null = null;
  const calls: string[] = [];
  const listeners = new Set<(raw: string) => void>();
  let respond = () => {};
  const scope = {
    LO: {
      get WebApp(): never {
        throw new Error("Legacy state must not be read");
      },
      MiniAppNative: {
        launchData: "fixture",
        protocolVersion: 1 as const,
        generation: "expand-fixture",
        operations: mode === "unsupported" ? [] : ["expand"],
        capabilities: mode === "unsupported" ? [] : ["expand"],
        snapshot: () => ({
          viewportHeight: 700,
          stableViewportHeight: 700,
          isFullscreen: true,
        }),
        subscribe: (listener: (raw: string) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        postMessage: (raw: string) => {
          const message = JSON.parse(raw);
          if (message.kind !== "request") return;
          calls.push(message.operation);
          respond = () => {
            for (const listener of listeners)
              listener(
                JSON.stringify({
                  channel: "lo.miniapp",
                  version: 1,
                  generation: "expand-fixture",
                  kind: "result",
                  id: message.id,
                  ok: mode !== "error",
                  ...(mode === "error"
                    ? {
                        error: {
                          code: "host_error",
                          message: "Expansion fixture refused",
                        },
                      }
                    : {}),
                }),
              );
          };
          if (mode !== "late") respond();
        },
      },
    },
  };
  const [bridge] = availableBridges(scope);
  const plan = createSuite({
    client: bridge.client,
    includeBot: false,
    consent: null,
    verified: () => {},
    observed: () => ({}),
    api: async () => assert.fail("No server operation expected"),
    interact: createInteraction((next) => {
      view = next;
    }),
  }).plan.filter((check) => check.id === "expand");
  assert.equal(plan.length, 1);
  const controller = new AbortController();
  const result = runChecks(
    plan,
    {
      id: "cleanup",
      label: "Cleanup",
      group: "test",
      execute: async () => "clean",
    },
    controller.signal,
    () => {},
  );
  return {
    result,
    controller,
    calls,
    view: () => view,
    respond: () => respond(),
  };
}

test("canonical expand needs an action and records success as unverified without a height question", async () => {
  const f = fixture();
  await drain();
  assert.deepEqual(f.calls, []);
  assert.ok(f.view());
  const question = f.view()!.question;
  f.view()!.start("");
  await drain();
  f.view()?.answer("yes");
  const report = await f.result;
  assert.deepEqual(f.calls, ["expand"]);
  assert.equal(report.checks[0].state, "manual");
  assert.equal(question, undefined);
  assert.notEqual(report.checks[0].evidence, "device");
  assert.match(report.checks[0].detail, /не сообщает состояние/);
});
test("canonical expand native refusal remains failed", async () => {
  const f = fixture("error");
  await drain();
  f.view()!.start("");
  const report = await f.result;
  assert.equal(report.checks[0].state, "failed");
  assert.match(report.checks[0].detail, /Expansion fixture refused/);
});
test("unsupported expand does not call native or ask a question", async () => {
  const f = fixture("unsupported");
  const report = await f.result;
  assert.equal(report.checks[0].state, "skipped");
  assert.deepEqual(f.calls, []);
  assert.equal(f.view(), null);
});
test("skipped expand never calls native", async () => {
  const f = fixture();
  await drain();
  f.view()!.answer("skip");
  const report = await f.result;
  assert.equal(report.checks[0].state, "manual");
  assert.match(report.checks[0].detail, /не выполнен/);
  assert.deepEqual(f.calls, []);
});
for (const started of [false, true])
  test(`Stop fences expand and late completion (started=${started})`, async () => {
    const f = fixture("late");
    await drain();
    const stale = f.view()!;
    if (started) stale.start("");
    f.controller.abort(new Error("Stopped fixture"));
    const report = await f.result;
    const before = JSON.stringify(report);
    stale.start("");
    f.respond();
    await drain();
    assert.equal(report.checks[0].state, "cancelled");
    assert.equal(JSON.stringify(report), before);
    assert.deepEqual(f.calls, started ? ["expand"] : []);
  });
