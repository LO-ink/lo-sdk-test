import test from "node:test";
import assert from "node:assert/strict";
import {
  canVerifyDelivery,
  createDeliveryCheck,
  createDeferredTicket,
  deferredKey,
  lastRunKey,
  persistDeferredResult,
  readDeferredTicket,
} from "../web/deferred.ts";
import { runChecks, summarize, type RunReport } from "../web/runner.ts";

import { createInteraction, type InteractionView } from "../web/interaction.ts";

const owner = { appId: "fixture-app", userId: "fixture-user" };
const version = "fixture-build";
const media = [
  "sendPhoto",
  "reusePhoto",
  "sendDocument",
  "reuseDocument",
  "sendVoice",
  "reuseVoice",
];
const success = {
  state: "passed" as const,
  detail: "user inspected existing files",
  evidence: "device" as const,
};
const storage = () => {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
};
const finished = (): RunReport => ({
  id: crypto.randomUUID(),
  owner: { ...owner },
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  state: "finished",
  checks: [...media.map((id) => `bot:${id}`), "bot:delivery", "cleanup"].map(
    (id) => ({
      id,
      label: id,
      group: "fixture",
      state: id === "bot:delivery" ? "manual" : "passed",
      detail: "fixture",
      durationMs: 0,
    }),
  ),
});

test("real runner finishes and restores before delivery inspection; reopening confirms without rerunning sends", async () => {
  let latest: RunReport | null = null;
  const sends: string[] = [];
  let releaseCleanup!: () => void;
  let cleanupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  // Synthetic plan uses the real runner and all six send identities, not live APIs.
  const plan = Array.from({ length: 198 }, (_, index) => {
    const operation = media[index];
    return {
      id: operation ? `bot:${operation}` : `fixture:${index}`,
      label: "fixture",
      group: "fixture",
      execute: async () => {
        if (operation) sends.push(operation);
        return "synthetic response";
      },
    };
  });
  const running = runChecks(
    [...plan, createDeliveryCheck(() => latest)],
    {
      id: "cleanup",
      label: "cleanup",
      group: "fixture",
      execute: async () => {
        cleanupStarted();
        await waiting;
        return "restored";
      },
    },
    new AbortController().signal,
    (update) => {
      latest = { ...update, owner: { ...owner } };
    },
  );
  await started;
  assert.equal(canVerifyDelivery(latest), false);
  assert.throws(() =>
    createDeferredTicket(latest!, "bot:delivery", version, owner),
  );
  releaseCleanup();
  await running;
  const report = latest! as RunReport;
  assert.equal(report.state, "finished");
  assert.equal(summarize(report).processed, 200);
  assert.equal(summarize(report).manual, 1);
  assert.equal(
    report.checks.find((c) => c.id === "bot:delivery")?.evidence,
    undefined,
  );
  assert.equal(canVerifyDelivery(report), true);

  const store = storage();
  const ticket = createDeferredTicket(
    report,
    "bot:delivery",
    version,
    owner,
    100,
  );
  store.setItem(lastRunKey, JSON.stringify({ appVersion: version, report }));
  store.setItem(deferredKey, JSON.stringify(ticket));
  // Destroyed WebView: only serialized state is available to the next instance.
  const reopened = JSON.parse(store.getItem(lastRunKey)!).report as RunReport;
  assert.deepEqual(
    readDeferredTicket(store, reopened, version, owner, 101),
    ticket,
  );
  const confirmed = persistDeferredResult(
    store,
    reopened,
    ticket,
    success,
    version,
    "fixture-dependencies",
    owner,
    101,
  )!;
  assert.equal(
    confirmed.checks.find((c) => c.id === "bot:delivery")?.evidence,
    "device",
  );
  assert.equal(
    report.checks.find((c) => c.id === "bot:delivery")?.state,
    "manual",
  );
  assert.equal(store.getItem(deferredKey), null);
  assert.equal(JSON.parse(store.getItem(lastRunKey)!).report.state, "finished");
  assert.deepEqual(sends, media);
});

test("legacy, interrupted, unrestored, incomplete and foreign-owner runs cannot start or resume delivery confirmation", () => {
  const good = finished();
  const ticket = createDeferredTicket(
    good,
    "bot:delivery",
    version,
    owner,
    100,
  );
  const invalid = [
    { ...good, owner: undefined },
    { ...good, owner: { ...owner, userId: "other-user" } },
    { ...good, owner: { ...owner, appId: "other-app" } },
    { ...good, state: "cancelled" as const },
    { ...good, state: "running" as const },
    { ...good, checks: good.checks.filter((c) => c.id !== "bot:reuseVoice") },
    ...["cleanup", ...media.map((id) => `bot:${id}`)].map((id) => ({
      ...good,
      checks: good.checks.map((c) =>
        c.id === id ? { ...c, state: "failed" as const } : c,
      ),
    })),
  ];
  for (const report of invalid) {
    const store = storage();
    store.setItem(deferredKey, JSON.stringify(ticket));
    assert.throws(() =>
      createDeferredTicket(report, "bot:delivery", version, owner, 100),
    );
    assert.equal(readDeferredTicket(store, report, version, owner, 101), null);
    assert.equal(
      persistDeferredResult(
        store,
        report,
        ticket,
        success,
        version,
        "fixture-dependencies",
        owner,
        101,
      ),
      report,
    );
    assert.equal(store.getItem(lastRunKey), null);
    assert.equal(store.getItem(deferredKey), JSON.stringify(ticket));
  }
});

test("delivery completion rechecks current account, build, age, run and attempt before writing", () => {
  const report = finished();
  const store = storage();
  const ticket = createDeferredTicket(
    report,
    "bot:delivery",
    version,
    owner,
    100,
  );
  store.setItem(deferredKey, JSON.stringify(ticket));
  for (const identity of [
    null,
    { ...owner, userId: "switched" },
    { ...owner, appId: "switched" },
  ]) {
    assert.equal(
      persistDeferredResult(
        store,
        report,
        ticket,
        success,
        version,
        "fixture-dependencies",
        identity,
        101,
      ),
      report,
    );
  }
  assert.equal(
    persistDeferredResult(
      store,
      report,
      ticket,
      success,
      "new-build",
      "fixture-dependencies",
      owner,
      101,
    ),
    report,
  );
  assert.equal(
    persistDeferredResult(
      store,
      report,
      ticket,
      success,
      version,
      "fixture-dependencies",
      owner,
      86400101,
    ),
    report,
  );
  const newer = finished();
  assert.equal(
    persistDeferredResult(
      store,
      newer,
      ticket,
      success,
      version,
      "fixture-dependencies",
      owner,
      101,
    ),
    newer,
  );
  const replacement = createDeferredTicket(
    report,
    "bot:delivery",
    version,
    owner,
    101,
  );
  store.setItem(deferredKey, JSON.stringify(replacement));
  assert.equal(
    persistDeferredResult(
      store,
      report,
      ticket,
      success,
      version,
      "fixture-dependencies",
      owner,
      102,
    ),
    report,
  );
  assert.equal(store.getItem(lastRunKey), null);
  assert.deepEqual(
    readDeferredTicket(store, report, version, owner, 102),
    replacement,
  );
});

test("failed durable confirmation preserves pending delivery; retry commits before retiring ticket", () => {
  const report = finished();
  const store = storage();
  const ticket = createDeferredTicket(
    report,
    "bot:delivery",
    version,
    owner,
    100,
  );
  store.setItem(deferredKey, JSON.stringify(ticket));
  assert.throws(
    () =>
      persistDeferredResult(
        {
          ...store,
          setItem: () => {
            throw new Error("quota");
          },
        },
        report,
        ticket,
        success,
        version,
        "fixture-dependencies",
        owner,
        101,
      ),
    /quota/,
  );
  assert.deepEqual(
    readDeferredTicket(store, report, version, owner, 102),
    ticket,
  );
  assert.equal(
    report.checks.find((c) => c.id === "bot:delivery")?.state,
    "manual",
  );
  const confirmed = persistDeferredResult(
    {
      ...store,
      removeItem: () => {
        throw new Error("storage became unavailable");
      },
    },
    report,
    ticket,
    success,
    version,
    "fixture-dependencies",
    owner,
    103,
  )!;
  assert.equal(
    confirmed.checks.find((c) => c.id === "bot:delivery")?.state,
    "passed",
  );
  const reopened = JSON.parse(store.getItem(lastRunKey)!).report;
  assert.equal(readDeferredTicket(store, reopened, version, owner, 104), null);
  assert.equal(
    persistDeferredResult(
      store,
      reopened,
      ticket,
      { state: "failed", detail: "late rejection" },
      version,
      "fixture-dependencies",
      owner,
      104,
    ),
    reopened,
  );
});

test("declining or skipping inspection never becomes confirmed delivery", () => {
  for (const state of ["failed", "manual"] as const) {
    const report = finished();
    const store = storage();
    const ticket = createDeferredTicket(
      report,
      "bot:delivery",
      version,
      owner,
      100,
    );
    store.setItem(deferredKey, JSON.stringify(ticket));
    const result = persistDeferredResult(
      store,
      report,
      ticket,
      { state, detail: "not confirmed" },
      version,
      "fixture-dependencies",
      owner,
      101,
    )!;
    assert.equal(
      result.checks.find((c) => c.id === "bot:delivery")?.evidence,
      undefined,
    );
    assert.equal(
      result.checks.find((c) => c.id === "bot:delivery")?.state,
      state,
    );
    assert.equal(
      report.checks.find((c) => c.id === "bot:delivery")?.state,
      "manual",
    );
  }
});

test("leaving a pending inspection cancels its old UI but reopening retains the same ticket", async () => {
  const report = finished();
  const store = storage();
  const ticket = createDeferredTicket(
    report,
    "bot:delivery",
    version,
    owner,
    100,
  );
  store.setItem(deferredKey, JSON.stringify(ticket));
  let view: InteractionView | null = null;
  const controller = new AbortController();
  const pending = createInteraction((next) => {
    view = next;
  })(
    {
      title: "delivery fixture",
      detail: "Inspect existing files",
      question: "Delivered?",
    },
    controller.signal,
  );
  const oldView = view! as InteractionView;
  controller.abort(new Error("WebView closed"));
  await assert.rejects(pending, /WebView closed/);
  oldView.answer("yes");
  assert.equal(view, null);
  assert.deepEqual(
    readDeferredTicket(store, report, version, owner, 101),
    ticket,
  );
  assert.equal(store.getItem(lastRunKey), null);
  const reopened = createInteraction((next) => {
    view = next;
  })(
    {
      title: "delivery fixture",
      detail: "Inspect existing files",
      question: "Delivered?",
    },
    new AbortController().signal,
  );
  (view! as InteractionView).answer("yes");
  assert.equal((await reopened).decision, "yes");
  const saved = persistDeferredResult(
    store,
    report,
    ticket,
    success,
    version,
    "fixture-dependencies",
    owner,
    102,
  )!;
  assert.equal(
    saved.checks.find((c) => c.id === "bot:delivery")?.evidence,
    "device",
  );
  assert.equal(store.getItem(deferredKey), null);
});
