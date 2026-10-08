import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://sdk-test.example",
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "getComputedStyle",
  "HTMLDialogElement",
  "Event",
  "MouseEvent",
  "localStorage",
  "sessionStorage",
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  });
}
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  writable: true,
  value: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
Object.defineProperty(globalThis, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
});

const { render, fireEvent, cleanup, waitFor } =
  await import("@testing-library/react");
const { App } = await import("../web/App.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  localStorage.clear();
  sessionStorage.clear();
});

for (const mode of [
  "export",
  "fresh",
  "wrong-owner",
  "unsigned",
  "identity-change",
  "concurrent",
  "quota",
  "archive-loss",
  "empty-archive",
] as const) {
  test(`actual App historical report ${mode} preserves provenance and fences host effects`, async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const saved = JSON.stringify({
      schema: 1,
      appVersion: "0.4.29",
      dependencies: "old-sdk@1",
      token: "private-extra",
      report: {
        id,
        owner: { appId: "fixture", userId: "42", token: "owner-secret" },
        startedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        state: "finished",
        checks: Array.from({ length: 200 }, (_, i) => ({
          id: `${i % 2 ? "compat" : "native"}:${i}`,
          label: `Old result ${i}`,
          group: "Old",
          state: i < 61 ? "passed" : "manual",
          detail: "Original diagnostic",
          durationMs: 1,
          token: "check-secret",
        })),
        recovery: Object.fromEntries(
          ["native", "compat"].map((route) => [
            route,
            {
              key: `lo-sdk-run-${id}-${route}`,
              written: [],
              mutations: [],
              original: {},
            },
          ]),
        ),
      },
    });
    localStorage.setItem("sdk-test.last-run", saved);
    const calls: string[] = [];
    const listeners = new Set<(raw: string) => void>();
    const host = {
      protocolVersion: 1,
      generation: `history-${mode}`,
      launchData: new URLSearchParams({
        app_id: "fixture",
        user: JSON.stringify({ id: mode === "wrong-owner" ? "other" : "42" }),
        auth_date: String(Math.floor(Date.now() / 1000)),
      }).toString(),
      operations: [
        "setBackgroundColor",
        "setBottomBarColor",
        "requestWriteAccess",
        "ready",
      ],
      capabilities: [
        "backgroundColor",
        "bottomBarColor",
        "requestWriteAccess",
        "ready",
      ],
      snapshot: () => ({ colorScheme: "light" }),
      subscribe: (listener: (raw: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      postMessage: (raw: string) => {
        const message = JSON.parse(raw);
        if (message.kind !== "request") return;
        calls.push(message.operation);
        for (const listener of listeners)
          listener(
            JSON.stringify({
              channel: "lo.miniapp",
              version: 1,
              generation: `history-${mode}`,
              kind: "result",
              id: message.id,
              ok: true,
              value: true,
            }),
          );
      },
    };
    Object.assign(globalThis, { LO: { MiniAppNative: host } });
    globalThis.fetch = async (url) => {
      if (String(url) === "/api/verify-launch") {
        if (mode === "identity-change")
          host.launchData += "&start_param=changed";
        if (mode === "concurrent")
          localStorage.setItem("sdk-test.last-run", "foreign debt");
        return new Response(
          JSON.stringify({
            verified: mode !== "unsigned",
            appId: "fixture",
            userId: "42",
          }),
          { status: mode === "unsigned" ? 403 : 200 },
        );
      }
      return new Response("{}", { status: 503 });
    };
    const originalSet = dom.window.Storage.prototype.setItem;
    dom.window.Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("sdk-test.history.")) {
        if (mode === "quota") throw new Error("quota");
        originalSet.call(this, key, value);
        if (mode === "archive-loss") this.removeItem(key);
        return;
      }
      originalSet.call(this, key, value);
    };
    try {
      const page = render(<App />);
      assert.ok(page.getByText("Сохранён прежний отчёт"));
      assert.equal(page.queryByText("Old result 0"), null);
      assert.equal(
        Boolean(page.queryByRole("button", { name: "Продолжить проверку" })),
        false,
      );
      assert.deepEqual(calls, []);
      const start = ["fresh", "quota", "archive-loss", "concurrent"].includes(
        mode,
      );
      if (mode === "concurrent")
        localStorage.setItem("sdk-test.last-run", "foreign debt");
      fireEvent.click(
        page.getByRole("button", {
          name: start
            ? "Начать проверку"
            : mode === "empty-archive"
              ? "Освободить место в архиве"
              : "Сохранить прежний отчёт",
        }),
      );
      if (mode === "export") {
        const field = await page.findByRole("textbox", { name: "JSON отчёта" });
        const exported = JSON.parse((field as HTMLTextAreaElement).value);
        assert.equal(exported.appVersion, "0.4.29");
        assert.equal(exported.historical, true);
        assert.equal(exported.currentEvidence, false);
        assert.equal(exported.report.checks.length, 200);
        assert.equal(exported.report.checks[0].state, "passed");
        assert.ok(!(field as HTMLTextAreaElement).value.includes("secret"));
        assert.ok(
          !(field as HTMLTextAreaElement).value.includes("private-extra"),
        );
      } else if (mode === "fresh") {
        await waitFor(() =>
          assert.equal(
            localStorage.getItem("sdk-test.last-run") !== saved,
            true,
          ),
        );
        const key = Object.keys(localStorage).find((key) =>
          key.startsWith("sdk-test.history."),
        )!;
        assert.equal(JSON.parse(localStorage.getItem(key)!).snapshot, saved);
        assert.ok(
          !localStorage.getItem("sdk-test.last-run")!.includes("compat:"),
        );
        const stop = page.queryByRole("button", {
          name: "Остановить проверку",
        });
        if (stop) fireEvent.click(stop);
        await waitFor(() =>
          assert.equal(
            Boolean(
              page.queryByRole("button", {
                name: /Остановить проверку|Останавливаем/,
              }),
            ),
            false,
          ),
        );
      } else {
        await waitFor(() =>
          assert.equal(
            Boolean(page.queryByRole("button", { name: "Проверяем доступ…" })),
            false,
          ),
        );
        assert.equal(
          Boolean(page.queryByRole("textbox", { name: "JSON отчёта" })),
          false,
        );
      }
      if (mode === "empty-archive") {
        assert.ok(
          await page.findByText(
            "Нет доступных архивных копий для удаления. Прежний отчёт будет сохранён в архиве при новом запуске. Если здесь есть копии другого аккаунта, откройте его в LO.",
          ),
        );
        assert.equal(
          Object.keys(localStorage).filter((key) =>
            key.startsWith("sdk-test.history."),
          ).length,
          0,
        );
        assert.equal(
          Boolean(page.queryByRole("textbox", { name: "JSON отчёта" })),
          false,
        );
      }
      if (mode !== "fresh") {
        assert.equal(
          localStorage.getItem("sdk-test.last-run"),
          mode === "concurrent" ? "foreign debt" : saved,
        );
        assert.deepEqual(calls, []);
      }
    } finally {
      cleanup();
      dom.window.Storage.prototype.setItem = originalSet;
      Reflect.deleteProperty(globalThis, "LO");
    }
  });
}

test("actual App current native resume ignores full foreign history while retaining completed evidence", async () => {
  const { historyKey } = await import("../web/history.ts");
  const foreign = JSON.stringify({
    schema: 1,
    appVersion: "0.4.29",
    dependencies: "old@1",
    report: {
      id: "11111111-1111-4111-8111-111111111111",
      owner: { appId: "foreign", userId: "other" },
      startedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      state: "finished",
      checks: [
        {
          id: "cleanup",
          label: "Foreign diagnostic",
          group: "old",
          state: "passed",
          detail: "private diagnostic",
          durationMs: 1,
        },
      ],
      recovery: {},
    },
  });
  for (let i = 0; i < 20; i++) {
    const snapshot = foreign.replace('"old@1"', `"old@${i + 1}"`);
    localStorage.setItem(
      historyKey(snapshot),
      JSON.stringify({
        schema: 1,
        kind: "historical-report",
        currentEvidence: false,
        snapshot,
      }),
    );
  }
  const archives = Object.keys(localStorage)
    .sort()
    .map((key) => [key, localStorage.getItem(key)]);
  Object.assign(globalThis, {
    LO: {
      MiniAppNative: {
        protocolVersion: 1,
        generation: "history-current-resume",
        launchData: new URLSearchParams({
          app_id: "fixture",
          user: JSON.stringify({ id: "42" }),
          auth_date: String(Math.floor(Date.now() / 1000)),
        }).toString(),
        operations: [],
        capabilities: [],
        snapshot: () => ({ colorScheme: "light" }),
        subscribe: () => () => {},
        postMessage() {},
      },
    },
  });
  globalThis.fetch = async (input) =>
    String(input).endsWith("/status")
      ? Response.json({ appConfigured: true, botConfigured: false })
      : String(input).endsWith("/session")
        ? Response.json({ verified: true, appId: "fixture", userId: "42" })
        : Response.json({}, { status: 503 });
  try {
    let page = render(<App />);
    assert.equal(Boolean(page.queryByText("private diagnostic")), false);
    fireEvent.click(page.getByRole("button", { name: "Начать проверку" }));
    await waitFor(() => assert.ok(page.getByText("Звук")));
    fireEvent.click(page.getByRole("button", { name: "Остановить проверку" }));
    await waitFor(() =>
      assert.ok(page.getByRole("button", { name: "Продолжить проверку" })),
    );
    const before = JSON.parse(
      localStorage.getItem("sdk-test.last-run")!,
    ).report;
    assert.deepEqual(before.owner, { appId: "fixture", userId: "42" });
    page.unmount();
    page = render(<App />);
    fireEvent.click(page.getByRole("button", { name: "Продолжить проверку" }));
    await waitFor(() => assert.ok(page.getByText("Звук")));
    const after = JSON.parse(localStorage.getItem("sdk-test.last-run")!).report;
    assert.equal(after.id, before.id);
    assert.equal(after.startedAt, before.startedAt);
    assert.deepEqual(after.checks[0], before.checks[0]);
    fireEvent.click(page.getByRole("button", { name: "Остановить проверку" }));
    await waitFor(() =>
      assert.ok(page.getByRole("button", { name: "Продолжить проверку" })),
    );
    assert.deepEqual(
      archives.map(([key]) => [key, localStorage.getItem(key!)]),
      archives,
    );
  } finally {
    cleanup();
    Reflect.deleteProperty(globalThis, "LO");
  }
});

test("actual App retired history does not bind current resume to unrelated archive", async () => {
  const h = await import("../web/history.ts");
  const make = (owner: string, age: number) =>
    JSON.stringify({
      schema: 1,
      appVersion: "old",
      dependencies: "old",
      report: {
        id: "55555555-5555-4555-8555-555555555555",
        owner: { appId: "fixture", userId: owner },
        startedAt: new Date(Date.now() - age).toISOString(),
        state: "finished",
        checks: [
          {
            id: "old",
            label: "old",
            group: "old",
            state: "passed",
            detail: "old",
            durationMs: 1,
          },
        ],
        recovery: {},
      },
    });
  const unrelated = make("foreign", 99000000);
  localStorage.setItem("sdk-test.last-run", unrelated);
  h.preserveHistory(localStorage, h.readHistorical(localStorage, "current")!);
  localStorage.setItem("sdk-test.last-run", make("42", 90000000));
  Object.assign(globalThis, {
    LO: {
      MiniAppNative: {
        protocolVersion: 1,
        generation: "retirement-current",
        launchData: new URLSearchParams({
          app_id: "fixture",
          user: JSON.stringify({ id: "42" }),
          auth_date: String(Math.floor(Date.now() / 1000)),
        }).toString(),
        operations: [],
        capabilities: [],
        snapshot: () => ({ colorScheme: "light" }),
        subscribe: () => () => {},
        postMessage() {},
      },
    },
  });
  globalThis.fetch = async (url) =>
    String(url).endsWith("/session") || String(url).endsWith("/verify-launch")
      ? Response.json({ verified: true, appId: "fixture", userId: "42" })
      : String(url).endsWith("/status")
        ? Response.json({ appConfigured: true, botConfigured: false })
        : Response.json({}, { status: 503 });
  try {
    const page = render(<App />);
    fireEvent.click(page.getByRole("button", { name: "Начать проверку" }));
    await page.findByText("Звук");
    fireEvent.click(page.getByRole("button", { name: "Остановить проверку" }));
    await page.findByRole("button", { name: "Продолжить проверку" });
    const before = localStorage.getItem("sdk-test.last-run");
    fireEvent.click(
      page.getByRole("button", { name: "Освободить место в архиве" }),
    );
    await page.findByRole("textbox", { name: "JSON отчёта" });
    fireEvent.click(
      page.getByRole("button", { name: "Копия сохранена — удалить из архива" }),
    );
    fireEvent.click(page.getByRole("button", { name: "Продолжить" }));
    await page.findByText(/Архивная копия удалена/);
    localStorage.removeItem(h.historyKey(unrelated));
    fireEvent.click(page.getByRole("button", { name: "Продолжить проверку" }));
    await waitFor(() =>
      assert.equal(
        Boolean(page.queryByText(/Прежний отчёт или архив изменился/)),
        false,
      ),
    );
    await page.findByText("Звук");
    assert.equal(
      JSON.parse(localStorage.getItem("sdk-test.last-run")!).report.id,
      JSON.parse(before!).report.id,
    );
    fireEvent.click(page.getByRole("button", { name: "Остановить проверку" }));
    await page.findByRole("button", { name: "Продолжить проверку" });
  } finally {
    cleanup();
    Reflect.deleteProperty(globalThis, "LO");
  }
});
