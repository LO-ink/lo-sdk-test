import assert from "node:assert/strict";
import test from "node:test";
import {
  readHistorical,
  readArchivedHistory,
  historicalExport,
  preserveHistory,
  assertHistoryArchived,
  historyKey,
  historyPrefix,
} from "../web/history.ts";
import { readRun, readRecovery } from "../web/run-storage.ts";
import { lastRunKey } from "../web/manual-recovery.ts";
const now = Date.now();
const owner = { appId: "fixture", userId: "42" };
function fixture() {
  const report = {
    id: "33333333-3333-4333-8333-333333333333",
    owner,
    startedAt: new Date(now - 2 * 86400000).toISOString(),
    state: "finished",
    checks: Array.from({ length: 200 }, (_, i) => ({
      id: `${i % 2 ? "compat" : "native"}:${i}`,
      label: `Old check ${i}`,
      group: "Old SDK",
      state:
        i < 61 ? "passed" : i < 63 ? "failed" : i < 87 ? "skipped" : "manual",
      detail: "Original diagnostic",
      durationMs: 1,
      authToken: "nested-secret",
    })),
    recovery: Object.fromEntries(
      ["native", "compat"].map((route) => [
        route,
        {
          key: `lo-sdk-run-33333333-3333-4333-8333-333333333333-${route}`,
          written: [],
          mutations: [],
          original: {},
        },
      ]),
    ),
  };
  const snapshot = JSON.stringify({
    schema: 1,
    appVersion: "0.4.29",
    dependencies: "old@1",
    report,
    token: "secret",
    launchData: "private",
  });
  const values = new Map([[lastRunKey, snapshot]]);
  const storage = {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  return {
    values,
    storage,
    snapshot,
    history: readHistorical(storage, "current", now)!,
  };
}
test("strict stale decoder preserves 200 historical states without current evidence or unknown fields", () => {
  const { storage, history, snapshot } = fixture();
  assert.equal(readRun(storage, "current", now), null);
  assert.equal(readRecovery(storage, "current", now), null);
  const exported = historicalExport(history, owner);
  const parsed = JSON.parse(exported);
  assert.equal(parsed.historical, true);
  assert.equal(parsed.currentEvidence, false);
  assert.equal(parsed.appVersion, "0.4.29");
  assert.equal(parsed.dependencies, "old@1");
  assert.equal(parsed.report.checks.length, 200);
  assert.equal(
    parsed.report.checks.filter((c: { state: string }) => c.state === "passed")
      .length,
    61,
  );
  for (const name of [
    "token",
    "launchData",
    "authToken",
    "snapshot",
    "sdkBuild",
    "recovery",
  ])
    assert.ok(!exported.includes(`"${name}"`));
  assert.equal(storage.getItem(lastRunKey), snapshot);
  for (const bad of [
    undefined,
    { appId: "other", userId: "42" },
    { appId: "fixture", userId: "other" },
  ])
    assert.throws(() => historicalExport(history, bad));
});
test("invalid schemas, future dates, malformed checks, and outstanding debt cannot become history", () => {
  for (const mutate of [
    (v: ReturnType<typeof JSON.parse>) => {
      v.schema = 2;
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.report.startedAt = new Date(now + 1000).toISOString();
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.report.checks[0].state = "invented";
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.report.recovery.native.written = ["deviceStorage"];
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.appVersion = {};
    },
  ]) {
    const { storage, values, snapshot } = fixture();
    const value = JSON.parse(snapshot);
    mutate(value);
    values.set(lastRunKey, JSON.stringify(value));
    assert.equal(readHistorical(storage, "current", now), null);
  }
});
test("current native evidence stays in current decoder, and interrupted historical values are not rewritten", () => {
  const { storage, values, snapshot } = fixture();
  const value = JSON.parse(snapshot);
  value.report.startedAt = new Date(now - 1000).toISOString();
  value.dependencies = "current";
  value.report.checks = [
    { ...value.report.checks[0], id: "cleanup", state: "passed" },
  ];
  delete value.report.recovery.compat;
  values.set(lastRunKey, JSON.stringify(value));
  assert.ok(readRun(storage, "current", now));
  assert.equal(readHistorical(storage, "current", now), null);
  value.dependencies = "old";
  value.report.state = "running";
  value.report.checks[0].state = "running";
  values.set(lastRunKey, JSON.stringify(value));
  assert.equal(
    readHistorical(storage, "current", now)!.report.checks[0].state,
    "running",
  );
});
test("archive is immutable, separate from cleanup, idempotent and readable after new-run replacement", () => {
  const { storage, values, history, snapshot } = fixture();
  preserveHistory(storage, history);
  const key = historyKey(snapshot);
  const archived = storage.getItem(key);
  preserveHistory(storage, history);
  assert.equal(storage.getItem(key), archived);
  assert.equal(storage.getItem(lastRunKey), snapshot);
  assert.equal(values.size, 2);
  values.set(lastRunKey, "new run");
  assert.equal(
    readArchivedHistory(storage, "current", now)!.snapshot,
    snapshot,
  );
  const raw = JSON.parse(archived!);
  assert.equal(raw.kind, "historical-report");
  assert.equal(raw.currentEvidence, false);
  assert.equal(raw.verified, undefined);
  values.delete(key);
  assert.throws(() => assertHistoryArchived(storage, history));
});
test("quota, collision, full archive and concurrent snapshots all refuse destructive replacement", () => {
  for (const mode of [
    "quota",
    "collision",
    "full",
    "before",
    "after",
    "readback",
    "removed",
    "bytes",
  ]) {
    const { storage, values, history, snapshot } = fixture();
    const key = historyKey(snapshot);
    if (mode === "collision") values.set(key, "other archive");
    if (mode === "full")
      for (let i = 0; i < 20; i++) values.set(historyPrefix + i, "retained");
    if (mode === "bytes")
      values.set(historyPrefix + "large", "x".repeat(4 * 1024 * 1024));
    if (mode === "before") values.set(lastRunKey, "new debt");
    const originalSet = storage.setItem;
    storage.setItem = (name, value) => {
      if (mode === "quota") throw new Error("quota");
      originalSet(name, value);
      if (mode === "after") values.set(lastRunKey, "new debt");
      if (mode === "readback") values.set(name, "foreign archive");
      if (mode === "removed") values.delete(name);
    };
    assert.throws(() => preserveHistory(storage, history), /./, mode);
    assert.equal(
      storage.getItem(lastRunKey),
      ["before", "after"].includes(mode) ? "new debt" : snapshot,
    );
  }
});

test("capacity recovery exports and explicitly retires only exact same-owner debt-free archives", async () => {
  const { oldestOwnedArchive, retireHistory } =
    await import("../web/history.ts");
  const { storage, values, history, snapshot } = fixture();
  preserveHistory(storage, history);
  const target = oldestOwnedArchive(storage, "current", owner, now)!;
  assert.equal(target.snapshot, snapshot);
  assert.equal(
    oldestOwnedArchive(
      storage,
      "current",
      { ...owner, userId: "foreign" },
      now,
    ),
    null,
  );
  const writable = {
    ...storage,
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  assert.throws(() => retireHistory(writable, target, owner, snapshot, false));
  assert.throws(() =>
    retireHistory(
      writable,
      target,
      { ...owner, userId: "foreign" },
      snapshot,
      true,
    ),
  );
  assert.throws(() =>
    retireHistory(writable, target, owner, "other run", true),
  );
  assertHistoryArchived(storage, target);
  retireHistory(writable, target, owner, snapshot, true);
  assert.equal(values.get(lastRunKey), snapshot);
  assert.equal(values.has(historyKey(snapshot)), false);
  preserveHistory(storage, history);
  assertHistoryArchived(storage, history);
});
test("archive retirement refuses observed replacement, denial, and retained archive readback", async () => {
  const { retireHistory } = await import("../web/history.ts");
  for (const mode of ["replaced", "denied", "retained"]) {
    const { storage, values, history, snapshot } = fixture();
    preserveHistory(storage, history);
    if (mode === "replaced") values.set(historyKey(snapshot), "foreign");
    const writable = {
      ...storage,
      removeItem: () => {
        if (mode === "denied") throw new Error("denied");
      },
    };
    assert.throws(() =>
      retireHistory(writable, history, owner, snapshot, true),
    );
    assert.equal(values.get(lastRunKey), snapshot);
    assert.ok(values.has(historyKey(snapshot)));
  }
});
test("historical text export removes explicitly labelled authentication payloads without changing stored diagnostics", () => {
  const { history } = fixture();
  history.report.checks[0].detail =
    'HTTP Authorization: Bearer abc.def-secret initData=user%3D42%26hash%3Draw query_id=secret-query signature="secret-signature"';
  const before = history.report.checks[0].detail;
  const result = historicalExport(history, owner);
  for (const value of [
    "abc.def-secret",
    "user%3D42",
    "secret-query",
    "secret-signature",
  ])
    assert.ok(!result.includes(value));
  assert.equal(history.report.checks[0].detail, before);
});

test("quoted JSON, percent-encoded launch queries and multiline headers do not expose labelled credentials", () => {
  for (const detail of [
    '{"token":"synthetic-secret","authToken":"auth-secret","accessToken":"access-secret","initData":"raw-launch","signature":"sig-private"}',
    "initData%3Duser%253D42%2526hash%253Dencoded-private",
    "Authorization:\nBearer multiline-private\r\nquery_id=private-query",
  ]) {
    const { history } = fixture();
    history.report.checks[0].detail = detail;
    const exported = historicalExport(history, owner);
    for (const secret of [
      "synthetic-secret",
      "raw-launch",
      "auth-secret",
      "access-secret",
      "sig-private",
      "encoded-private",
      "multiline-private",
      "private-query",
    ])
      assert.ok(!exported.includes(secret));
    assert.equal(history.report.checks[0].detail, detail);
  }
});

test("historical execution receipts remain allowlisted while exact archive bytes and owner fences remain intact", async () => {
  const { currentBuild, recordExecution } =
    await import("../web/provenance.ts");
  const { storage, values, snapshot } = fixture();
  const saved = JSON.parse(snapshot);
  const old = { ...currentBuild, appVersion: "0.4.38" };
  saved.report.checks[0].execution = recordExecution(saved.report, old);
  saved.report.provenance.builds.b1.privateExtra = "private launch";
  const original = JSON.stringify(saved);
  values.set(lastRunKey, original);
  const history = readHistorical(storage, "current", now)!;
  preserveHistory(storage, history);
  const exported = JSON.parse(historicalExport(history, owner));
  assert.equal(exported.report.provenance.builds.b1.appVersion, "0.4.38");
  assert.equal(exported.report.provenance.builds.b1.privateExtra, undefined);
  assert.deepEqual(
    exported.report.checks[0].execution,
    saved.report.checks[0].execution,
  );
  assert.equal(exported.executionAttribution.unknown, 199);
  assert.equal(
    exported.appVersionMeaning,
    "last-serializer-version-not-execution-provenance",
  );
  assert.equal(
    JSON.parse(storage.getItem(historyKey(original))!).snapshot,
    original,
  );
  assert.equal(storage.getItem(lastRunKey), original);
  assert.throws(() =>
    historicalExport(history, { appId: "fixture", userId: "other" }),
  );
});
