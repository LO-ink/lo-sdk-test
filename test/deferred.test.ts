import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDeferredResult,
  canRunDeferred,
  persistDeferredResult,
  clearDeferredTicket,
  createDeferredTicket,
  deferredKey,
  ownsDeferredTicket,
  readDeferredTicket,
  verifyDeferredData,
} from "../web/deferred.ts";
import type { RunReport } from "../web/runner.ts";
const identity = { appId: "fixture-app", userId: "fixture-user" };
const report = (): RunReport => ({
  id: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
  state: "finished",
  owner: { ...identity },
  checks: ["native:sendData", "compat:sendData", "native:close", "cleanup"].map(
    (id) => ({
      id,
      label: id,
      group: "test",
      state: id === "cleanup" ? "passed" : "manual",
      detail: "pending",
      durationMs: 0,
    }),
  ),
});
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};

test("each native sendData attempt has a distinct persisted payload that survives reopening", () => {
  const store = storage(),
    run = report();
  const tickets = ["native:sendData", "native:sendData", "native:sendData"].map(
    (id) => createDeferredTicket(run, id, "0.4.10", identity, 100),
  );
  assert.equal(new Set(tickets.map((ticket) => ticket.data)).size, 3);
  for (const ticket of tickets) {
    store.setItem(deferredKey, JSON.stringify(ticket));
    assert.deepEqual(
      readDeferredTicket(store, run, "0.4.10", identity, 101),
      ticket,
    );
    assert.match(ticket.data!, /^lo-sdk-test:[a-f0-9-]{36}$/);
  }
});

test("tickets from another run, build, app, user, stale time or legacy schema cannot confirm a check", () => {
  const store = storage(),
    run = report();
  const ticket = createDeferredTicket(
    run,
    "native:sendData",
    "0.4.10",
    identity,
    100,
  );
  for (const changed of [
    { runId: "old-run" },
    { appVersion: "old-build" },
    { appId: "other-app" },
    { userId: "other-user" },
    { createdAt: 86400201 },
    { createdAt: -86400000 },
    { attemptId: "bad" },
    { data: "sdk-test" },
    { schema: undefined },
    { operation: "close" },
    { id: "compat:sendData" },
    { bridgeId: "other" },
  ]) {
    store.setItem(deferredKey, JSON.stringify({ ...ticket, ...changed }));
    assert.equal(
      readDeferredTicket(store, run, "0.4.10", identity, 101),
      null,
      JSON.stringify(changed),
    );
  }
  store.setItem(deferredKey, "{broken");
  assert.equal(readDeferredTicket(store, run, "0.4.10", identity, 101), null);
});

test("late failure or confirmation from an earlier attempt cannot retire the latest ticket", () => {
  const store = storage(),
    run = report();
  const old = createDeferredTicket(run, "native:sendData", "0.4.10", identity);
  const current = createDeferredTicket(
    run,
    "native:sendData",
    "0.4.10",
    identity,
  );
  store.setItem(deferredKey, JSON.stringify(current));
  assert.equal(ownsDeferredTicket(store, old), false);
  clearDeferredTicket(store, old);
  assert.equal(ownsDeferredTicket(store, current), true);
  clearDeferredTicket(store, current);
  assert.equal(store.getItem(deferredKey), null);
});

test("correlated result affects only its original manual check, while skips remain unverified", () => {
  const run = report();
  const ticket = createDeferredTicket(
    run,
    "native:sendData",
    "0.4.10",
    identity,
  );
  const success = {
    state: "passed" as const,
    detail: "exact nonce matched",
    evidence: "data" as const,
  };
  const newerRun = report();
  assert.equal(applyDeferredResult(newerRun, ticket, success), newerRun);
  const result = applyDeferredResult(run, ticket, success)!;
  assert.equal(result.checks[0].evidence, "data");
  assert.equal(result.checks[1].state, "manual");
  const skipped = applyDeferredResult(run, ticket, {
    state: "manual",
    detail: "not checked",
  })!;
  assert.equal(skipped.checks[0].evidence, undefined);
  assert.equal(
    applyDeferredResult(result, ticket, {
      state: "failed",
      detail: "late rejection",
    })!.checks[0].state,
    "passed",
  );
});

test("a valid signed session verifies the exact nonce without replacing session or sending data again", async () => {
  const ticket = createDeferredTicket(
    report(),
    "native:sendData",
    "0.4.10",
    identity,
  );
  const calls: unknown[] = [];
  assert.equal(
    await verifyDeferredData(
      ticket,
      "synthetic-launch",
      async <T>(path: string, body: unknown) => {
        calls.push([path, body]);
        return { found: true } as T;
      },
      new AbortController().signal,
    ),
    true,
  );
  assert.deepEqual(calls, [
    ["send-data/verify", { data: ticket.data, ...identity }],
  ]);
});

test("expired session is reverified once; wrong signed identity, missing nonce or network failure cannot pass", async () => {
  const ticket = createDeferredTicket(
    report(),
    "native:sendData",
    "0.4.10",
    identity,
  );
  for (const outcome of [
    "matched",
    "wrong-user",
    "wrong-app",
    "not-found",
    "network",
  ] as const) {
    const calls: string[] = [];
    const result = verifyDeferredData(
      ticket,
      "synthetic-launch",
      async <T>(path: string) => {
        calls.push(path);
        if (calls.length === 1)
          throw Object.assign(new Error("expired"), { status: 401 });
        if (path === "session")
          return {
            userId: outcome === "wrong-user" ? "other" : identity.userId,
            appId: outcome === "wrong-app" ? "other" : identity.appId,
          } as T;
        if (outcome === "network") throw new Error("offline");
        return { found: outcome === "matched" } as T;
      },
      new AbortController().signal,
    );
    if (outcome === "matched") assert.equal(await result, true);
    else await assert.rejects(result);
    assert.deepEqual(
      calls,
      outcome === "wrong-user" || outcome === "wrong-app"
        ? ["send-data/verify", "session"]
        : ["send-data/verify", "session", "send-data/verify"],
    );
  }
});

test("late positive correlation after cancellation cannot confirm a deferred action", async () => {
  const ticket = createDeferredTicket(
    report(),
    "native:sendData",
    "0.4.10",
    identity,
  );
  const controller = new AbortController();
  await assert.rejects(
    verifyDeferredData(
      ticket,
      "synthetic-launch",
      async <T>() => {
        controller.abort(new Error("stopped"));
        return { found: true } as T;
      },
      controller.signal,
    ),
    /stopped/,
  );
});

test("every deferred action rejects foreign owners and unrestored reports at creation, reload and commit", () => {
  for (const id of ["native:sendData", "native:close"]) {
    const good = report();
    const ticket = createDeferredTicket(good, id, "build", identity);
    const store = storage();
    store.setItem(deferredKey, JSON.stringify(ticket));
    const invalid: RunReport[] = [
      { ...good, owner: undefined },
      { ...good, owner: { ...identity, userId: "other-user" } },
      { ...good, owner: { ...identity, appId: "other-app" } },
      { ...good, state: "running" },
      { ...good, state: "cancelled" },
      { ...good, resumeBlocked: true },
      { ...good, checks: good.checks.filter((c) => c.id !== "cleanup") },
      {
        ...good,
        checks: good.checks.map((c) =>
          c.id === "cleanup" ? { ...c, state: "failed" } : c,
        ),
      },
      {
        ...good,
        recovery: {
          native: {
            key: "owned",
            written: [],
            mutations: ["exitFullscreen"],
            original: { isFullscreen: true },
          },
        },
      },
    ];
    const passed = {
      state: "passed" as const,
      detail: "confirmed",
      evidence: "device" as const,
    };
    for (const changed of invalid) {
      assert.equal(canRunDeferred(changed, id, identity), false);
      assert.throws(() => createDeferredTicket(changed, id, "build", identity));
      assert.equal(readDeferredTicket(store, changed, "build", identity), null);
      assert.equal(applyDeferredResult(changed, ticket, passed), changed);
      assert.equal(
        persistDeferredResult(
          store,
          changed,
          ticket,
          passed,
          "build",
          "deps",
          identity,
        ),
        changed,
      );
      assert.equal(store.getItem("sdk-test.last-run"), null);
      assert.notEqual(store.getItem(deferredKey), null);
    }
    const foreign = { ...identity, userId: "new-account" };
    assert.throws(() => createDeferredTicket(good, id, "build", foreign));
    assert.equal(canRunDeferred(good, id, null), false);
    assert.equal(canRunDeferred(good, id, identity), true);
    assert.equal(
      persistDeferredResult(
        store,
        good,
        ticket,
        passed,
        "build",
        "deps",
        identity,
      )!.checks.find((c) => c.id === id)!.state,
      "passed",
    );
  }
});
