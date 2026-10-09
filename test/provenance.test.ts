import assert from "node:assert/strict";
import test from "node:test";
import {
  attributionSummary,
  currentBuild,
  normalizeProvenance,
  recordExecution,
} from "../web/provenance.ts";
import { runChecks, type Check, type RunReport } from "../web/runner.ts";
import { readRun, saveRun } from "../web/run-storage.ts";
import { applyDeferredResult, createDeferredTicket } from "../web/deferred.ts";
const id = "11111111-1111-4111-8111-111111111111";
const check = (id: string): Check => ({
  id,
  label: id,
  group: "fixture",
  execute: async () => "OK",
});
const fixture = (): RunReport => ({
  id,
  startedAt: new Date().toISOString(),
  state: "cancelled",
  owner: { appId: "app", userId: "42" },
  checks: [
    { ...check("old"), state: "passed", detail: "old data", durationMs: 137 },
    { ...check("next"), state: "cancelled", detail: "not run", durationMs: 0 },
    { ...check("cleanup"), state: "passed", detail: "clean", durationMs: 1 },
  ],
});

test("deduplicated build receipts survive reload; mixed builds and latest preparation are separately attributed", async () => {
  const before = fixture();
  const oldBuild = {
    ...currentBuild,
    appVersion: "0.4.38",
    configuredGoVerifier: {
      ...currentBuild.configuredGoVerifier,
      toolchain: "go1.27.1",
    },
  };
  before.checks[0].execution = recordExecution(before, oldBuild);
  const old = { ...before.checks[0] };
  const oldReceipt = structuredClone(before.provenance);
  let prepared = 0;
  const after = await runChecks(
    [check("old"), check("next")],
    check("cleanup"),
    new AbortController().signal,
    () => {},
    100,
    {
      previous: before,
      prepare: async () => {
        prepared++;
      },
    },
  );
  assert.equal(prepared, 1);
  assert.deepEqual(after.checks[0], old);
  assert.deepEqual(before.provenance, oldReceipt);
  const current = after.checks[1].execution!;
  assert.notEqual(current.build, old.execution!.build);
  assert.equal(after.checks[2].execution!.build, current.build);
  assert.equal(
    after.provenance!.latestResumePreparation!.execution.build,
    current.build,
  );
  assert.equal(after.provenance!.latestResumePreparation!.state, "passed");
  assert.equal(Object.keys(after.provenance!.builds).length, 2);
  let raw = "";
  const store = {
    getItem: () => raw,
    setItem: (_k: string, v: string) => {
      raw = v;
    },
  };
  saveRun(store, after, "0.4.39", "fixture");
  assert.deepEqual(
    readRun(store, "fixture"),
    JSON.parse(JSON.stringify(after)),
  );
});

test("legacy and malformed provenance never erase valid owned cleanup debt or fabricate build identity", () => {
  for (const provenance of [
    undefined,
    { schema: 1, builds: { b1: { token: "private" } } },
    {
      schema: 1,
      builds: Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`b${i + 1}`, currentBuild]),
      ),
    },
  ]) {
    const report = fixture();
    report.recovery = {
      native: {
        key: `lo-sdk-run-${id}-native`,
        written: ["deviceStorage"],
        mutations: [],
        original: {},
      },
    };
    Object.assign(report, { provenance });
    report.checks[0].execution = {
      build: "b1",
      evaluatedAt: new Date().toISOString(),
    };
    const raw = JSON.stringify({
      schema: 1,
      appVersion: "0.4.38",
      dependencies: "same",
      report,
    });
    const parsed = readRun(
      {
        getItem: () => raw,
        setItem: () => {
          throw Error("write");
        },
      },
      "same",
    )!;
    assert.ok(parsed);
    assert.deepEqual(parsed.recovery, report.recovery);
    assert.equal(parsed.checks[0].durationMs, 137);
    assert.equal(parsed.checks[0].execution!.build, null);
    assert.deepEqual(parsed.provenance!.builds, {});
    assert.equal(JSON.stringify(parsed.provenance).includes("private"), false);
    assert.equal(attributionSummary(parsed).unknown, 3);
  }
});

test("receipt capacity is explicit unknown and still permits cleanup without reassigning old references", async () => {
  const report = fixture();
  report.checks = [];
  for (let i = 0; i < 64; i++) {
    const c = {
      ...check(`old${i}`),
      state: "passed" as const,
      detail: "done",
      durationMs: 1,
    };
    report.checks.push(c);
    report.checks.at(-1)!.execution = recordExecution(report, {
      ...currentBuild,
      appVersion: `0.3.${i}`,
    });
  }
  report.checks.push({
    ...check("cleanup"),
    state: "passed",
    detail: "clean",
    durationMs: 1,
  });
  // Unfinished work keeps this a resumable plan without replaying completed work.
  report.checks.unshift({
    ...check("next"),
    state: "cancelled",
    detail: "pending",
    durationMs: 0,
  });
  const references = report.checks.slice(1, -1).map((c) => c.execution);
  const after = await runChecks(
    report.checks.slice(0, -1).map((c) => check(c.id)),
    check("cleanup"),
    new AbortController().signal,
    () => {},
    100,
    { previous: report },
  );
  assert.equal(after.state, "finished");
  assert.equal(after.checks[0].execution!.unknown, "receipt-capacity");
  assert.equal(after.checks.at(-1)!.execution!.unknown, "receipt-capacity");
  assert.deepEqual(
    after.checks.slice(1, -1).map((c) => c.execution),
    references,
  );
  assert.equal(Object.keys(after.provenance!.builds).length, 64);
});

test("cancelled preparation and excluded/untouched checks do not invent completed evaluations", async () => {
  const abort = new AbortController();
  const after = await runChecks(
    [check("old"), check("next")],
    check("cleanup"),
    abort.signal,
    () => {},
    100,
    {
      previous: fixture(),
      prepare: async () => {
        abort.abort();
        throw Error("stop");
      },
    },
  );
  assert.equal(after.provenance!.latestResumePreparation!.state, "cancelled");
  assert.equal(after.checks[1].execution!.unknown, "not-evaluated");
  assert.equal(after.checks[1].execution!.evaluatedAt, undefined);
  const excluded = await runChecks(
    [
      {
        ...check("excluded"),
        scopeExcluded: true,
        skip: () => ({ state: "manual", detail: "unselected" }),
      },
    ],
    check("cleanup"),
    new AbortController().signal,
    () => {},
  );
  assert.equal(excluded.checks[0].execution!.evaluatedAt, undefined);
  assert.equal(excluded.checks[0].execution!.unknown, "not-evaluated");
});

test("deferred confirmation has its own current evaluation attribution without mutating carried outcomes", () => {
  const report = fixture();
  report.state = "finished";
  report.checks = [
    {
      ...check("native:close"),
      state: "manual",
      detail: "Confirm",
      durationMs: 0,
    },
    report.checks[2],
  ];
  const ticket = createDeferredTicket(
    report,
    "native:close",
    "0.4.39",
    report.owner!,
  );
  const updated = applyDeferredResult(report, ticket, {
    state: "passed",
    detail: "Observed",
    evidence: "device",
  })!;
  assert.ok(updated.checks[0].execution!.evaluatedAt);
  assert.equal(
    updated.provenance!.builds[updated.checks[0].execution!.build!].appVersion,
    currentBuild.appVersion,
  );
  assert.equal(report.checks[0].execution, undefined);
  assert.deepEqual(updated.checks[0].durationExecution, {
    build: null,
    unknown: "legacy",
  });
  assert.equal(updated.checks[1].execution!.unknown, "legacy");
});

test("untrusted deep/extra provenance and dangling references normalize without losing cleanup", () => {
  const report = fixture();
  report.recovery = {
    native: {
      key: `lo-sdk-run-${id}-native`,
      written: [],
      mutations: ["setBackgroundColor"],
      original: {},
    },
  };
  let deep: unknown = null;
  for (let i = 0; i < 8000; i++) deep = { nested: deep };
  Object.assign(report, {
    provenance: {
      schema: 1,
      builds: { b1: { ...currentBuild, extra: deep } },
      unexpected: deep,
    },
  });
  report.checks[0].execution = {
    build: "b1",
    evaluatedAt: new Date().toISOString(),
  };
  report.checks[1].execution = {
    build: "b2",
    evaluatedAt: new Date().toISOString(),
  };
  const normalized = normalizeProvenance(report);
  assert.deepEqual(normalized.recovery, report.recovery);
  assert.equal(normalized.checks[0].execution!.build, "b1");
  assert.equal(normalized.checks[1].execution!.unknown, "invalid-metadata");
  assert.equal(JSON.stringify(normalized.provenance).includes("nested"), false);
  assert.equal(Object.keys(normalized.provenance!.builds).length, 1);
});

test("published provenance snapshots are immutable and skip attribution is not a native call", async () => {
  const snapshots: RunReport[] = [];
  let calls = 0;
  const report = await runChecks(
    [
      {
        ...check("skip"),
        skip: () => ({ state: "skipped", detail: "No capability" }),
        execute: async () => {
          calls++;
          return "unexpected";
        },
      },
    ],
    check("cleanup"),
    new AbortController().signal,
    (r) => snapshots.push(r),
    100,
    { prepare: async () => {} },
  );
  assert.equal(calls, 0);
  assert.equal(report.checks[0].state, "skipped");
  assert.ok(report.checks[0].execution!.build);
  assert.ok(report.checks[0].execution!.evaluatedAt);
  const running = snapshots.find(
    (s) => s.provenance?.latestResumePreparation?.state === "running",
  )!;
  assert.ok(running);
  assert.equal(
    running.provenance!.latestResumePreparation!.finishedAt,
    undefined,
  );
  assert.equal(running.checks[0].execution!.build, null);
  assert.equal(report.provenance!.latestResumePreparation!.state, "passed");
  assert.notEqual(running.provenance, report.provenance);
  const saved = JSON.stringify(running);
  report.provenance!.builds = {};
  assert.equal(JSON.stringify(running), saved);
});

test("deferred confirmations retain original duration attribution; genuine retry measures anew", async () => {
  const before = fixture();
  before.state = "finished";
  before.checks = [
    {
      ...check("native:close"),
      state: "manual",
      detail: "Confirm",
      durationMs: 137,
    },
    before.checks[2],
  ];
  const oldBuild = { ...currentBuild, appVersion: "0.4.38" };
  before.checks[0].execution = recordExecution(before, oldBuild);
  const original = before.checks[0].execution;
  const ticket = createDeferredTicket(
    before,
    "native:close",
    "0.4.39",
    before.owner!,
  );
  const pending = applyDeferredResult(before, ticket, {
    state: "manual",
    detail: "Need confirmation",
  })!;
  const final = applyDeferredResult(pending, ticket, {
    state: "passed",
    detail: "Observed",
    evidence: "device",
  })!;
  assert.deepEqual(final.checks[0].durationExecution, original);
  assert.notEqual(final.checks[0].execution!.build, original!.build);
  assert.equal(final.checks[0].durationMs, 137);
  assert.equal(final.provenance!.builds[original!.build!].appVersion, "0.4.38");
  assert.deepEqual(normalizeProvenance(final).checks[0], final.checks[0]);
  final.state = "cancelled";
  final.checks[0].state = "cancelled";
  const rerun = await runChecks(
    [check("native:close")],
    check("cleanup"),
    new AbortController().signal,
    () => {},
    100,
    { previous: final },
  );
  assert.equal(rerun.checks[0].durationExecution, undefined);
  assert.equal(
    rerun.provenance!.builds[rerun.checks[0].execution!.build!].appVersion,
    currentBuild.appVersion,
  );
  assert.equal(
    Object.values(rerun.provenance!.builds).some(
      (b) => b.appVersion === "0.4.38",
    ),
    false,
  );
});
