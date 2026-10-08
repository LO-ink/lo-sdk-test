import assert from "node:assert/strict";
import test from "node:test";
import type { MiniAppClient } from "@lo-ink/miniapp-sdk";
import type { Bridge } from "../web/bridges.ts";
import { canResume, type RunReport } from "../web/runner.ts";
import { recoverRun, recoveryPending } from "../web/recovery.ts";
import {
  lastRunKey,
  readRecovery,
  readRun,
  saveRecovery,
  saveRun,
  type RecoveryTicket,
} from "../web/run-storage.ts";
const now = Date.parse("2026-10-07T10:00:00Z");
const id = "11111111-1111-4111-8111-111111111111";
const owner = { appId: "test-app", userId: "42" };
function fixture(age = 60000, dependencies = "old") {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const report: RunReport = {
    id,
    owner,
    startedAt: new Date(now - age).toISOString(),
    state: "cancelled",
    suiteRevision: 1,
    checks: [
      {
        id: "done",
        label: "done",
        group: "fixture",
        state: "passed",
        detail: "Old evidence",
        durationMs: 1,
      },
      {
        id: "cleanup",
        label: "cleanup",
        group: "fixture",
        state: "failed",
        detail: "Interrupted",
        durationMs: 1,
      },
    ],
    recovery: {
      native: {
        key: `lo-sdk-run-${id}-native`,
        written: ["cloudStorage", "deviceStorage", "secureStorage"],
        mutations: [],
        original: {},
      },
    },
  };
  saveRun(storage, report, "0.4.28", dependencies);
  return { storage, report };
}
function bridge(
  options: {
    owner?: typeof owner;
    reject?: string;
    afterCall?: () => void;
  } = {},
) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const current = options.owner ?? owner;
  const host: Bridge = {
    id: "native",
    label: "Native",
    client: {
      adapter: { snapshot: () => ({}) },
      launchUnsafe: () => ({
        appId: current.appId,
        user: { id: current.userId },
      }),
      supports: () => true,
      call: async (name: string, input: unknown) => {
        calls.push({ name, input });
        options.afterCall?.();
        if (name === options.reject) throw new Error("Host refusal");
        return true;
      },
    } as unknown as MiniAppClient,
  };
  return { host, calls };
}
const signal = () => new AbortController().signal;

test("SDK upgrades and expiry retain only owned validated cleanup intent, never stale evidence", () => {
  for (const [age, deps] of [
    [60000, "old"],
    [86400001, "current"],
  ] as const) {
    const { storage, report } = fixture(age, deps);
    assert.equal(readRun(storage, "current", now), null);
    const ticket = readRecovery(storage, "current", now)!;
    assert.equal(ticket.id, id);
    assert.deepEqual(ticket.owner, owner);
    assert.deepEqual(ticket.recovery, report.recovery);
    assert.equal("checks" in ticket, false);
    assert.equal("state" in ticket, false);
    assert.equal(readRun(storage, "current", now), null);
    assert.equal(storage.getItem(lastRunKey), ticket.snapshot);
  }
  const fresh = fixture(60000, "current");
  assert.ok(readRun(fresh.storage, "current", now));
  assert.equal(readRecovery(fresh.storage, "current", now), null);
});

test("cleanup-only loading rejects malformed, future or debt-free records", () => {
  const { storage } = fixture();
  const original = JSON.parse(storage.getItem(lastRunKey)!);
  for (const change of [
    (saved: typeof original) => {
      saved.schema = 2;
    },
    (saved: typeof original) => {
      saved.report.state = ["cancelled"];
    },
    (saved: typeof original) => {
      saved.report.startedAt = new Date(now + 1).toISOString();
    },
    (saved: typeof original) => {
      saved.report.recovery.native.key = "unrelated";
    },
    (saved: typeof original) => {
      saved.report.recovery.native.written = ["arbitrary"];
    },
    (saved: typeof original) => {
      saved.report.recovery.native.mutations = ["close"];
    },
    (saved: typeof original) => {
      saved.report.recovery.native.original = { unknown: true };
    },
    (saved: typeof original) => {
      saved.report.recovery = {};
    },
  ]) {
    const saved = structuredClone(original);
    change(saved);
    storage.setItem(lastRunKey, JSON.stringify(saved));
    assert.equal(readRecovery(storage, "current", now), null);
  }
});

test("cleanup-only execution removes exactly recorded keys without preparing new fixtures or resuming checks", async () => {
  const { storage } = fixture();
  const ticket = readRecovery(storage, "current", now)!;
  const { host, calls } = bridge();
  const updates: RecoveryTicket[] = [];
  const after = await recoverRun(ticket, [host], storage, signal(), (update) =>
    updates.push(update),
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ["cloudStorageRemove", "deviceStorageRemove", "secureStorageRemove"],
  );
  for (const call of calls)
    assert.deepEqual(call.input, { key: `lo-sdk-run-${id}-native` });
  assert.equal(updates.length, 3);
  assert.equal(recoveryPending(after), false);
  const saved = JSON.parse(storage.getItem(lastRunKey)!);
  assert.equal(saved.dependencies, "old");
  assert.equal(saved.appVersion, "0.4.28");
  assert.deepEqual(
    saved.report.checks,
    JSON.parse(ticket.snapshot).report.checks,
  );
  assert.equal(readRun(storage, "current", now), null);
  assert.equal(readRecovery(storage, "current", now), null);
});

test("partial and unavailable restoration preserve remaining intent across an expired reload", async () => {
  const { storage } = fixture(86400001);
  let ticket = readRecovery(storage, "current", now)!;
  const first = bridge({ reject: "secureStorageRemove" });
  await assert.rejects(
    recoverRun(ticket, [first.host], storage, signal(), (update) => {
      ticket = update;
    }),
    /secureStorage/,
  );
  assert.deepEqual(ticket.recovery.native.written, ["secureStorage"]);
  ticket = readRecovery(storage, "current", now + 86400000)!;
  const snapshot = storage.getItem(lastRunKey);
  await assert.rejects(
    recoverRun(ticket, [], storage, signal(), () => assert.fail()),
    /мост недоступен/,
  );
  assert.equal(storage.getItem(lastRunKey), snapshot);
  const second = bridge();
  await recoverRun(ticket, [second.host], storage, signal(), () => {});
  assert.deepEqual(
    second.calls.map((call) => call.name),
    ["secureStorageRemove"],
  );
  assert.equal(readRecovery(storage, "current", now + 86400000), null);
});

test("foreign identities and changed storage are refused before any host effects", async () => {
  for (const changed of [
    { appId: "other", userId: "42" },
    { appId: "test-app", userId: "43" },
    { appId: "", userId: "" },
  ]) {
    const { storage } = fixture();
    const ticket = readRecovery(storage, "current", now)!;
    const { host, calls } = bridge({ owner: changed });
    await assert.rejects(
      recoverRun(ticket, [host], storage, signal(), () => assert.fail()),
      /аккаунте/,
    );
    assert.deepEqual(calls, []);
    assert.equal(storage.getItem(lastRunKey), ticket.snapshot);
  }
  const { storage } = fixture();
  const ticket = readRecovery(storage, "current", now)!;
  const { host, calls } = bridge();
  storage.setItem(lastRunKey, "new record");
  assert.throws(() => saveRecovery(storage, ticket, {}), /изменился/);
  await assert.rejects(
    recoverRun(ticket, [host], storage, signal(), () => assert.fail()),
    /изменился/,
  );
  assert.deepEqual(calls, []);
  assert.equal(storage.getItem(lastRunKey), "new record");
});

test("a competing ledger write during cleanup is never overwritten", async () => {
  const { storage } = fixture();
  const ticket = readRecovery(storage, "current", now)!;
  const { host, calls } = bridge({
    afterCall: () => storage.setItem(lastRunKey, "new record"),
  });
  await assert.rejects(
    recoverRun(ticket, [host], storage, signal(), () => assert.fail()),
  );
  assert.equal(storage.getItem(lastRunKey), "new record");
  assert.equal(calls.length, 1);
});

test("unsupported button restoration and cancellation never retire intent", async () => {
  const { storage, report } = fixture();
  report.recovery!.native.written = [];
  report.recovery!.native.mutations = ["setButton"];
  report.recovery!.native.buttons = ["back"];
  saveRun(storage, report, "0.4.28", "old");
  const ticket = readRecovery(storage, "current", now)!;
  const { host, calls } = bridge();
  host.client!.supports = () => false;
  await assert.rejects(
    recoverRun(ticket, [host], storage, signal(), () => assert.fail()),
    /setButton:back/,
  );
  assert.deepEqual(calls, []);
  assert.equal(storage.getItem(lastRunKey), ticket.snapshot);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    recoverRun(ticket, [host], storage, controller.signal, () => assert.fail()),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, []);
  assert.equal(storage.getItem(lastRunKey), ticket.snapshot);
});

test("checkpoint storage failure prevents subsequent cleanup effects and preserves the original ledger", async () => {
  const { storage } = fixture();
  const ticket = readRecovery(storage, "current", now)!;
  storage.setItem = () => {
    throw new Error("Storage quota");
  };
  const { host, calls } = bridge();
  await assert.rejects(
    recoverRun(ticket, [host], storage, signal(), () => assert.fail()),
  );
  assert.equal(calls.length, 1);
  assert.equal(storage.getItem(lastRunKey), ticket.snapshot);
});

test("cancellation during a host call stops later effects and leaves conservative retry intent", async () => {
  const { storage } = fixture();
  const ticket = readRecovery(storage, "current", now)!;
  const controller = new AbortController();
  const { host, calls } = bridge({ afterCall: () => controller.abort() });
  await assert.rejects(
    recoverRun(ticket, [host], storage, controller.signal, () => {}),
  );
  assert.equal(calls.length, 1);
  assert.ok(recoveryPending(readRecovery(storage, "current", now)));
});

test("removed-route cleanup remains visible and never executes through a native client, even with current dependencies", async () => {
  const { storage, report } = fixture(60000, "current");
  report.recovery = {
    compat: {
      key: `lo-sdk-run-${id}-compat`,
      written: ["deviceStorage"],
      mutations: ["setButton"],
      original: {},
    },
  };
  saveRun(storage, report, "old-app", "current");
  assert.equal(readRun(storage, "current", now), null);
  const ticket = readRecovery(storage, "current", now)!;
  assert.ok(ticket);
  const before = storage.getItem(lastRunKey);
  const { host, calls } = bridge();
  await assert.rejects(
    recoverRun(ticket, [host], storage, signal(), () =>
      assert.fail("No durable cleanup was performed"),
    ),
    /ручная очистка/,
  );
  assert.deepEqual(calls, []);
  assert.equal(storage.getItem(lastRunKey), before);
  assert.equal(recoveryPending(readRecovery(storage, "current", now)), true);
});

test("an old cleanup ledger without ownership remains manual-only instead of disappearing", async () => {
  for (const route of ["native", "compat"] as const) {
    const { storage, report } = fixture();
    delete report.owner;
    report.recovery = {
      [route]: {
        key: `lo-sdk-run-${id}-${route}`,
        written: ["deviceStorage"],
        mutations: [],
        original: {},
      },
    };
    saveRun(storage, report, "old-app", "old-dependencies");
    const before = storage.getItem(lastRunKey);
    const ticket = readRecovery(storage, "current", now)!;
    assert.equal(ticket.owner, undefined);
    assert.equal(recoveryPending(ticket), true);
    const { host, calls } = bridge();
    await assert.rejects(
      recoverRun(ticket, [host], storage, signal(), () =>
        assert.fail("Unknown identity cannot be restored automatically"),
      ),
      /Владелец.*неизвестен/,
    );
    assert.deepEqual(calls, []);
    assert.equal(storage.getItem(lastRunKey), before);
  }
});

test("recent current-build unknown-owner debt becomes manual-only while debt-free results stay visible", async () => {
  const { storage, report } = fixture(60000, "current");
  delete report.owner;
  saveRun(storage, report, "current-app", "current");
  const before = storage.getItem(lastRunKey);
  assert.equal(canResume(report), false);
  assert.equal(readRun(storage, "current", now), null);
  const ticket = readRecovery(storage, "current", now)!;
  assert.ok(ticket);
  const { host, calls } = bridge();
  await assert.rejects(
    recoverRun(ticket, [host], storage, signal(), () =>
      assert.fail("No owner"),
    ),
    /неизвестен/,
  );
  assert.deepEqual(calls, []);
  assert.equal(storage.getItem(lastRunKey), before);
  report.state = "finished";
  report.recovery = {};
  report.checks[1].state = "passed";
  saveRun(storage, report, "current-app", "current");
  assert.ok(readRun(storage, "current", now));
  assert.equal(readRecovery(storage, "current", now), null);
});
