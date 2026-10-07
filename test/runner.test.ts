import test from "node:test";
import assert from "node:assert/strict";
import {
  bounded,
  CheckTimeout,
  runChecks,
  summarize,
  type Check,
  type RunReport,
} from "../web/runner.ts";
import { createSuite } from "../web/suite.ts";
import { operationNames, events } from "../web/cases.ts";
import type { MiniAppClient } from "@lo-ink/miniapp-sdk";
const check = (id: string, execute: Check["execute"]): Check => ({
  id,
  label: id,
  group: "test",
  execute,
});
const cleanup = check("cleanup", async () => "clean");
test("sequential checks isolate failures, publish immutable progress, and do not count skips as success", async () => {
  const order: string[] = [],
    reports: RunReport[] = [];
  const report = await runChecks(
    [
      check("a", async () => {
        order.push("a");
        return "ok";
      }),
      check("b", async () => {
        order.push("b");
        throw new Error("wrong value");
      }),
      {
        ...check("unsupported", async () => {
          throw new Error("must not call");
        }),
        skip: () => ({ state: "skipped" as const, detail: "unsupported" }),
      },
      {
        ...check("payment", async () => {
          throw new Error("must not call");
        }),
        skip: () => ({ state: "manual" as const, detail: "payment" }),
      },
    ],
    cleanup,
    new AbortController().signal,
    (r) => reports.push(r),
  );
  assert.deepEqual(order, ["a", "b"]);
  assert.deepEqual(summarize(report), {
    passed: 2,
    failed: 1,
    tested: 3,
    skipped: 1,
    manual: 1,
    total: 5,
    processed: 5,
    progress: 100,
    success: 67,
  });
  assert.equal(reports[0].checks[0].state, "pending");
  assert.equal(report.state, "finished");
});
test("a host that ignores abort still times out; independent checks continue", async () => {
  const report = await runChecks(
    [
      check("hang", () => new Promise(() => {})),
      check("next", async () => "ok"),
    ],
    cleanup,
    new AbortController().signal,
    () => {},
    20,
  );
  assert.equal(report.checks[0].state, "failed");
  assert.match(report.checks[0].detail, /Нет ответа/);
  assert.equal(report.checks[1].state, "passed");
});
test("stop cancels current and future checks but runs cleanup with a fresh signal", async () => {
  const controller = new AbortController();
  let cleaned = false;
  const report = await runChecks(
    [
      check("stop", async () => {
        controller.abort();
        return "must not count";
      }),
      check("never", async () => {
        throw new Error("must not call");
      }),
    ],
    check("cleanup", async (signal) => {
      assert.equal(signal.aborted, false);
      cleaned = true;
      return "clean";
    }),
    controller.signal,
    () => {},
  );
  assert.equal(cleaned, true);
  assert.equal(report.state, "cancelled");
  assert.equal(report.checks[0].state, "cancelled");
  assert.equal(report.checks[1].state, "cancelled");
  assert.equal(summarize(report).progress, 33);
});
test("cleanup failure is visible and zero executed tests has no success percentage", async () => {
  const report = await runChecks(
    [],
    check("cleanup", async () => {
      throw new Error("cleanup failed");
    }),
    new AbortController().signal,
    () => {},
  );
  assert.equal(report.checks[0].state, "failed");
  assert.equal(summarize({ ...report, checks: [] }).success, null);
});
test("timeout aborts the underlying request and an already aborted signal does not invoke work", async () => {
  let cancelled = false;
  await assert.rejects(
    bounded(
      (signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            cancelled = true;
          });
        }),
      new AbortController().signal,
      10,
    ),
  );
  assert.equal(cancelled, true);
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    bounded(async () => {
      called = true;
    }, controller.signal),
  );
  assert.equal(called, false);
});
test("suite covers every host operation and event and distinguishes synthetic errors from live checks", () => {
  const { plan } = createSuite({
    client: null,
    api: async () => {
      throw new Error("unused");
    },
    consent: null,
    includeBot: false,
    verified: () => {},
    observed: () => ({}),
  });
  for (const name of operationNames)
    assert.equal(plan.filter((c) => c.id === name).length, 1);
  for (const name of events)
    assert.equal(plan.filter((c) => c.id === `event:${name}`).length, 1);
  assert.equal(
    plan.filter((c) => c.group.includes("синтетические")).length,
    14,
  );
  assert.equal(
    plan.find((c) => c.id === "event:themeChanged")!.skip!()!.state,
    "manual",
  );
});
test("storage roundtrips verify values, preserve unrelated data and clean after failure", async () => {
  const values = new Map<string, string>([["existing-user-key", "keep"]]);
  const used: string[] = [];
  const client = {
    adapter: { launchData: "" },
    supports: (c: string) => c === "cloudStorage",
    call: async (
      name: string,
      input: { key: string; value: string; keys: string[] },
    ) => {
      if (input?.key) used.push(input.key);
      if (name === "cloudStorageSet") {
        values.set(input.key, input.value);
        return true;
      }
      if (name === "cloudStorageGet") return "wrong value";
      if (name === "cloudStorageGetMany")
        return Object.fromEntries(input.keys.map((k) => [k, values.get(k)]));
      if (name === "cloudStorageKeys") return [...values.keys()];
      if (name === "cloudStorageRemove") {
        values.delete(input.key);
        return true;
      }
      if (name === "cloudStorageRemoveMany") {
        for (const k of input.keys) values.delete(k);
        return true;
      }
    },
  } as unknown as MiniAppClient;
  const suite = createSuite({
    client,
    api: async () => {
      throw new Error("unused");
    },
    consent: null,
    includeBot: false,
    verified: () => {},
    observed: () => ({}),
  });
  const report = await runChecks(
    suite.plan.filter((c) => c.id.startsWith("cloudStorage")),
    suite.cleanup,
    new AbortController().signal,
    () => {},
  );
  assert.equal(
    report.checks.find((c) => c.id === "cloudStorageSet")!.state,
    "failed",
  );
  assert.equal(
    report.checks.find((c) => c.id === "cloudStorageGet")!.state,
    "skipped",
  );
  assert.deepEqual([...values.entries()], [["existing-user-key", "keep"]]);
  assert.equal(
    used.every((k) => k.startsWith("lo-sdk-run-")),
    true,
  );
});
test("bot writes never run without consent or the run option, even after signed launch", async () => {
  const requested: string[] = [];
  const client = {
    adapter: { launchData: "synthetic" },
  } as unknown as MiniAppClient;
  for (const [consent, includeBot] of [
    [false, true],
    [true, false],
    [null, false],
  ] as const) {
    const suite = createSuite({
      client,
      consent,
      includeBot,
      verified: () => {},
      observed: () => ({}),
      api: async <T>(path: string, body: unknown) => {
        if (path === "status")
          return { appConfigured: true, botConfigured: true } as T;
        if (path === "session") return { verified: true } as T;
        if (path === "bot") {
          requested.push((body as { operation: string }).operation);
          return { mode: "live", result: [] } as T;
        }
        return {} as T;
      },
    });
    const report = await runChecks(
      suite.plan.filter((c) =>
        ["server", "signature", "bot:sendMessage"].includes(c.id),
      ),
      suite.cleanup,
      new AbortController().signal,
      () => {},
    );
    assert.equal(
      report.checks.find((c) => c.id === "bot:sendMessage")!.state,
      "skipped",
    );
  }
  assert.deepEqual(requested, []);
});

test("start requests LO write access synchronously and settles cancellation without an unhandled rejection", async () => {
  const { beginWriteAccess } = await import("../web/consent.ts");
  const controller = new AbortController();
  let called = false;
  let aborted = false;
  const client = {
    call: (
      _name: string,
      _input: unknown,
      options: { signal: AbortSignal },
    ) => {
      called = true;
      options.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    },
  } as unknown as MiniAppClient;
  const result = beginWriteAccess(client, controller.signal);
  assert.equal(called, true);
  controller.abort();
  assert.equal((await result).allowed, false);
  assert.equal(aborted, true);
});

test("one run verifies the signature and persists LO consent before any bot write", async () => {
  for (const mode of [
    "allowed",
    "denied",
    "permission-error",
    "save-error",
  ] as const) {
    const calls: string[] = [];
    const suite = createSuite({
      client: {
        adapter: { launchData: "synthetic" },
        supports: () => true,
      } as unknown as MiniAppClient,
      consent: null,
      includeBot: true,
      writeAccess: () =>
        Promise.resolve({
          allowed: mode !== "denied",
          ...(mode === "permission-error"
            ? { error: "permission failed" }
            : {}),
        }),
      consentChanged: (allowed) => calls.push(`consent:${allowed}`),
      verified: () => calls.push("verified"),
      observed: () => ({}),
      api: async <T>(path: string, body: unknown) => {
        calls.push(path);
        if (path === "status")
          return { appConfigured: true, botConfigured: true } as T;
        if (path === "session") return { verified: true } as T;
        if (path === "consent" && mode === "save-error")
          throw new Error("save failed");
        if (path === "bot") {
          calls.push((body as { operation: string }).operation);
          return { mode: "live", result: true } as T;
        }
        return {} as T;
      },
    });
    const report = await runChecks(
      suite.plan.filter((c) =>
        [
          "server",
          "signature",
          "requestWriteAccess",
          "bot:sendMessage",
        ].includes(c.id),
      ),
      suite.cleanup,
      new AbortController().signal,
      () => {},
    );
    const send = report.checks.find((c) => c.id === "bot:sendMessage")!;
    assert.equal(send.state, mode === "allowed" ? "passed" : "skipped");
    if (mode === "allowed")
      assert.deepEqual(calls, [
        "status",
        "session",
        "verified",
        "consent:true",
        "consent",
        "bot",
        "sendMessage",
      ]);
    else assert.equal(calls.includes("sendMessage"), false);
  }
});
test("unanswered user interaction stays unverified while a real operation error stays failed", async () => {
  const report = await runChecks(
    [
      {
        id: "user",
        label: "user",
        group: "test",
        timeoutMs: 5,
        timeoutState: "manual",
        execute: () => new Promise(() => {}),
      },
      {
        id: "nested",
        label: "nested",
        group: "test",
        timeoutMs: 100,
        timeoutState: "manual",
        execute: async () => {
          throw new CheckTimeout(3);
        },
      },
      {
        id: "api",
        label: "api",
        group: "test",
        timeoutState: "manual",
        execute: async () => {
          throw new Error("native operation failed");
        },
      },
    ],
    {
      id: "cleanup",
      label: "cleanup",
      group: "test",
      execute: async () => "clean",
    },
    new AbortController().signal,
    () => {},
  );
  assert.equal(report.checks[0].state, "manual");
  assert.equal(report.checks[1].state, "failed");
  assert.equal(report.checks[1].detail, "Нет ответа за 0.003 с");
  assert.equal(report.checks[2].state, "failed");
  assert.equal(report.checks[2].detail, "native operation failed");
});

test("an accepted storage write without persisted data cannot pass", async () => {
  const client = {
    adapter: { launchData: "" },
    supports: (name: string) => name === "deviceStorage",
    call: async (name: string) => (name === "deviceStorageGet" ? null : true),
  } as unknown as MiniAppClient;
  const suite = createSuite({
    client,
    api: async () => ({}) as never,
    consent: null,
    includeBot: false,
    verified: () => {},
    observed: () => ({}),
  });
  const report = await runChecks(
    suite.plan.filter((c) => c.id === "deviceStorageSet"),
    suite.cleanup,
    new AbortController().signal,
    () => {},
  );
  assert.equal(report.checks[0].state, "failed");
  assert.match(report.checks[0].detail, /не подтверждена чтением/);
});

test("cached write consent alone cannot count as a fresh bridge check", async () => {
  const suite = createSuite({
    client: {
      adapter: { launchData: "synthetic" },
      supports: () => true,
    } as unknown as MiniAppClient,
    api: async <T>(path: string) =>
      (path === "status"
        ? { appConfigured: true, botConfigured: true }
        : { verified: true }) as T,
    consent: true,
    includeBot: true,
    verified: () => {},
    observed: () => ({}),
  });
  const report = await runChecks(
    suite.plan.filter((c) =>
      ["server", "signature", "requestWriteAccess"].includes(c.id),
    ),
    suite.cleanup,
    new AbortController().signal,
    () => {},
  );
  assert.equal(
    report.checks.find((c) => c.id === "requestWriteAccess")!.state,
    "manual",
  );
});

test("per-case finalizer is awaited outside an action timeout before the next case", async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  let actionSignal: AbortSignal;
  const work = runChecks(
    [
      {
        ...check("flag", async (signal) => {
          actionSignal = signal;
          return new Promise(() => {});
        }),
        timeoutMs: 10,
        finalize: async (signal) => {
          assert.equal(actionSignal.aborted, true);
          assert.equal(signal.aborted, false);
          order.push("restore-start");
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          order.push("restore-end");
        },
      },
      check("next", async () => {
        order.push("next");
        return "done";
      }),
    ],
    cleanup,
    new AbortController().signal,
    () => {},
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(order, ["restore-start"]);
  release();
  await work;
  assert.deepEqual(order, ["restore-start", "restore-end", "next"]);
});

test("failed per-case restoration stops contaminated followups and still runs aggregate fallback", async () => {
  let fallback = false;
  const report = await runChecks(
    [
      {
        ...check("flag", async () => ({
          state: "passed",
          detail: "device observed",
          evidence: "device",
        })),
        finalize: async () => {
          throw new Error("restore denied");
        },
      },
      check("compat", async () =>
        assert.fail("Cannot test against leaked native state"),
      ),
    ],
    check("cleanup", async () => {
      fallback = true;
      return "restored";
    }),
    new AbortController().signal,
    () => {},
  );
  assert.equal(fallback, true);
  assert.equal(report.state, "cancelled");
  assert.equal(report.checks[0].state, "failed");
  assert.equal(report.checks[0].evidence, undefined);
  assert.match(report.checks[0].detail, /restore denied/);
  assert.equal(report.checks[1].state, "cancelled");
});
