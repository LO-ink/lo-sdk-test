import assert from "node:assert/strict";
import test from "node:test";
import {
  attestManualCleanup,
  cleanupTicketExport,
  isManuallyRetired,
  lastRunKey,
  manualArchiveKey,
  manualArchivePrefix,
  manualOnlyRecovery,
} from "../web/manual-recovery.ts";
import { readRecovery, readRun } from "../web/run-storage.ts";
const now = Date.parse("2026-10-08T10:00:00Z");
function fixture() {
  const id = "11111111-1111-4111-8111-111111111111";
  const snapshot = JSON.stringify({
    schema: 1,
    appVersion: "old",
    dependencies: "old",
    report: {
      id,
      owner: { appId: "old-app", userId: "old-user" },
      startedAt: new Date(now - 60000).toISOString(),
      state: "cancelled",
      checks: [
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
        compat: {
          key: `lo-sdk-run-${id}-compat`,
          written: ["deviceStorage"],
          mutations: ["setButton", "requestFullscreen", "setBackgroundColor"],
          buttons: ["main", "back"],
          original: { isFullscreen: false, theme: { background: "#123456" } },
        },
      },
    },
  });
  const values = new Map([[lastRunKey, snapshot]]);
  const storage = {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  return {
    storage,
    values,
    snapshot,
    ticket: readRecovery(storage, "current", now)!,
  };
}
test("manual attestation archives exact owner/settings/results without rewriting evidence; reload retires only exact snapshot", () => {
  const { storage, ticket, values, snapshot } = fixture();
  const exported = JSON.parse(cleanupTicketExport(ticket));
  assert.deepEqual(exported.obligations, ticket.recovery);
  assert.deepEqual(exported.owner, ticket.owner);
  assert.equal("originalSnapshot" in exported, false);
  attestManualCleanup(storage, ticket, true);
  assert.equal(storage.getItem(lastRunKey), snapshot);
  assert.equal(values.size, 2);
  const archive = JSON.parse(storage.getItem(manualArchiveKey(snapshot))!);
  assert.equal(archive.verified, false);
  assert.equal(archive.kind, "external-cleanup-attestation");
  assert.equal(archive.snapshot, snapshot);
  assert.equal(JSON.parse(archive.snapshot).report.checks[0].state, "failed");
  assert.equal(readRecovery(storage, "current", now), null);
  assert.equal(readRun(storage, "old", now), null);
  const before = storage.getItem(manualArchiveKey(snapshot));
  attestManualCleanup(storage, ticket, true);
  assert.equal(storage.getItem(manualArchiveKey(snapshot)), before);
  assert.equal(values.size, 2);
  const different = JSON.parse(snapshot);
  different.report.owner.userId = "someone-else";
  storage.setItem(lastRunKey, JSON.stringify(different));
  assert.ok(readRecovery(storage, "current", now));
});
test("confirmation, original identity and outstanding-route fences refuse forged or automatic tickets", () => {
  const { storage, ticket, values } = fixture();
  assert.throws(
    () => attestManualCleanup(storage, ticket, false),
    /Подтвердите/,
  );
  assert.throws(
    () =>
      attestManualCleanup(
        storage,
        { ...ticket, owner: { appId: "new", userId: "new" } },
        true,
      ),
    /изменился/,
  );
  const native = { ...ticket, recovery: { native: ticket.recovery.compat } };
  assert.equal(manualOnlyRecovery(native), false);
  assert.throws(
    () => attestManualCleanup(storage, native, true),
    /Подтвердите/,
  );
  assert.equal(manualOnlyRecovery({ ...native, owner: undefined }), true);
  assert.equal(values.size, 1);
});
test("archive failure or corruption keeps original obligations active and never deletes sibling records", () => {
  for (const mode of [
    "quota",
    "corrupt",
    "collision",
    "full",
    "bytes",
  ] as const) {
    const { storage, ticket, values, snapshot } = fixture();
    const key = manualArchiveKey(snapshot);
    values.set(`${manualArchivePrefix}sibling`, "untouched");
    if (mode === "collision") values.set(key, "foreign");
    if (mode === "full")
      for (let i = 0; i < 20; i++)
        values.set(`${manualArchivePrefix}${i}`, "old");
    if (mode === "bytes")
      values.set(`${manualArchivePrefix}large`, "x".repeat(4 * 1024 * 1024));
    const broken = {
      ...storage,
      setItem(name: string, value: string) {
        if (mode === "quota")
          throw new DOMException("quota", "QuotaExceededError");
        storage.setItem(name, mode === "corrupt" ? "broken" : value);
      },
    };
    assert.throws(() => attestManualCleanup(broken, ticket, true));
    assert.equal(storage.getItem(lastRunKey), snapshot);
    assert.ok(readRecovery(storage, "current", now));
    assert.equal(storage.getItem(`${manualArchivePrefix}sibling`), "untouched");
  }
});
test("replacements before, during and after archive writes survive unchanged; no destructive removal exists", () => {
  for (const phase of ["before", "during", "after"] as const) {
    const { storage, ticket, values, snapshot } = fixture();
    const replacement = snapshot.replace('"old-user"', '"replacement-user"');
    const key = manualArchiveKey(snapshot);
    if (phase === "before") storage.setItem(lastRunKey, replacement);
    const racing = {
      ...storage,
      setItem(name: string, value: string) {
        if (phase === "during") values.set(lastRunKey, replacement);
        storage.setItem(name, value);
      },
      getItem(name: string) {
        if (phase === "after" && name === key && values.has(key))
          values.set(lastRunKey, replacement);
        return storage.getItem(name);
      },
    };
    assert.throws(() => attestManualCleanup(racing, ticket, true), /изменился/);
    assert.equal(storage.getItem(lastRunKey), replacement);
    assert.equal(isManuallyRetired(storage, replacement), false);
    assert.ok(readRecovery(storage, "current", now));
  }
});
test("a concurrently added sibling archive is preserved and mismatched archive ownership never authorizes retirement", () => {
  const { storage, ticket, values, snapshot } = fixture();
  const key = manualArchiveKey(snapshot),
    sibling = `${manualArchivePrefix}sibling`;
  const racing = {
    ...storage,
    setItem(name: string, value: string) {
      values.set(sibling, "another completed archive");
      storage.setItem(name, value);
    },
  };
  attestManualCleanup(racing, ticket, true);
  assert.equal(values.get(sibling), "another completed archive");
  const archive = JSON.parse(storage.getItem(key)!);
  archive.snapshot += " ";
  storage.setItem(key, JSON.stringify(archive));
  assert.equal(isManuallyRetired(storage, snapshot), false);
  assert.ok(readRecovery(storage, "current", now));
});

test("cleanup export excludes unrelated legacy credentials and unknown nested fields while private archive preserves exact original", () => {
  const { storage, snapshot } = fixture();
  const saved = JSON.parse(snapshot);
  saved.auth = "synthetic-auth-secret";
  saved.report.owner.token = "synthetic-owner-secret";
  saved.report.recovery.compat.authorization = "synthetic-recovery-secret";
  saved.report.checks[0].detail = "synthetic-check-secret";
  const raw = JSON.stringify(saved);
  storage.setItem(lastRunKey, raw);
  const ticket = readRecovery(storage, "current", now)!;
  assert.ok(ticket);
  const exported = cleanupTicketExport(ticket);
  for (const secret of [
    "synthetic-auth-secret",
    "synthetic-owner-secret",
    "synthetic-recovery-secret",
    "synthetic-check-secret",
  ])
    assert.equal(exported.includes(secret), false);
  assert.deepEqual(
    JSON.parse(exported).obligations.compat.original,
    saved.report.recovery.compat.original,
  );
  attestManualCleanup(storage, ticket, true);
  assert.equal(
    JSON.parse(storage.getItem(manualArchiveKey(raw))!).snapshot,
    raw,
  );
});
