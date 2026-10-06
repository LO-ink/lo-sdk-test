import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import type { InteractionView } from "../web/interaction.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://sdk-test.example",
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
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
const { ActionConfirmation } = await import("../web/ActionConfirmation.tsx");
const { RunInteraction } = await import("../web/RunInteraction.tsx");
const { RunPage } = await import("../web/RunPage.tsx");
const { App } = await import("../web/App.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  localStorage.clear();
  sessionStorage.clear();
});

function versionsUnavailable() {
  globalThis.fetch = async () =>
    new Response("{}", {
      status: 503,
      headers: { "content-type": "application/json" },
    });
}

test("confirmation requires an explicit choice and releases the dialog", () => {
  let accepted = 0,
    cancelled = 0;
  const page = render(
    <ActionConfirmation
      title="Close application"
      detail="Unsaved input will be lost."
      onConfirm={() => {
        accepted++;
      }}
      onCancel={() => {
        cancelled++;
      }}
    />,
  );
  const dialog = page.getByRole("dialog") as HTMLDialogElement;
  assert.equal(dialog.open, true);
  fireEvent.click(page.getByRole("button", { name: "Отмена" }));
  assert.equal(cancelled, 1);
  assert.equal(accepted, 0);
  fireEvent.click(page.getByRole("button", { name: "Продолжить" }));
  assert.equal(accepted, 1);
  fireEvent(dialog, new dom.window.Event("cancel"));
  assert.equal(cancelled, 2);
  page.unmount();
  assert.equal(dialog.open, false);
});

test("interaction gates empty input, starts from a click and keeps stop available while busy", () => {
  const started: string[] = [],
    decisions: string[] = [];
  let stopped = 0;
  const view: InteractionView = {
    title: "Clipboard",
    detail: "Enter text",
    input: { label: "Text", preserveFocus: true },
    phase: "ready",
    attempt: 0,
    start: (text) => {
      started.push(text);
    },
    repeat: (text) => {
      started.push(text);
    },
    answer: (decision) => {
      decisions.push(decision);
    },
  };
  const page = render(
    <RunInteraction
      view={view}
      onStop={() => {
        stopped++;
      }}
    />,
  );
  const start = page.getByRole("button", {
    name: "Проверить",
  }) as HTMLButtonElement;
  assert.equal(start.disabled, true);
  fireEvent.change(page.getByLabelText("Text"), { target: { value: "hello" } });
  assert.equal(start.disabled, false);
  fireEvent.click(start);
  assert.deepEqual(started, ["hello"]);
  page.rerender(
    <RunInteraction
      view={{ ...view, phase: "busy", attempt: 2 }}
      onStop={() => {
        stopped++;
      }}
    />,
  );
  assert.equal(page.queryByRole("button", { name: "Пропустить" }), null);
  assert.equal(page.getByRole("region").getAttribute("aria-busy"), "true");
  fireEvent.click(page.getByRole("button", { name: "Остановить" }));
  assert.equal(stopped, 1);
  page.rerender(
    <RunInteraction
      view={{
        ...view,
        phase: "confirm",
        attempt: 2,
        action: async () => undefined,
        question: "Did it work?",
      }}
      onStop={() => {
        stopped++;
      }}
    />,
  );
  fireEvent.click(page.getByRole("button", { name: "Да" }));
  fireEvent.click(page.getByRole("button", { name: "Нет" }));
  fireEvent.click(page.getByRole("button", { name: "Пропустить" }));
  fireEvent.click(page.getByRole("button", { name: "Повторить действие" }));
  assert.deepEqual(decisions, ["yes", "no", "skip"]);
  assert.deepEqual(started, ["hello", "hello"]);
});

test("empty run shows an actionable start and leaves unavailable SDK versions unverified", async () => {
  versionsUnavailable();
  let started = 0;
  const page = render(
    <RunPage
      report={null}
      interaction={null}
      starting={false}
      stopping={false}
      exporting={false}
      onStart={() => {
        started++;
      }}
      onStop={() => {}}
      onExport={() => {}}
      onDeferred={() => {}}
    />,
  );
  fireEvent.click(page.getByRole("button", { name: "Проверить все мосты" }));
  assert.equal(started, 1);
  await waitFor(() =>
    assert.ok(page.getByText("GitHub недоступен. Актуальность не проверена.")),
  );
  assert.equal(page.queryByText("Актуальна"), null);
});

test("manual checks without a host cannot send messages and display a failed server check", async () => {
  const operations: string[] = [];
  globalThis.fetch = async (input, options) => {
    const path = String(input);
    if (path.endsWith("/status"))
      return Response.json({
        appConfigured: false,
        botConfigured: false,
        origin: null,
      });
    if (path.endsWith("/bot")) {
      operations.push(JSON.parse(String(options?.body)).operation);
      return Response.json(
        { message: "Fixture server unavailable", code: "unavailable" },
        { status: 503 },
      );
    }
    return Response.json({}, { status: 503 });
  };
  const page = render(<App />);
  assert.ok(page.getByText("Откройте в LO для живых проверок"));
  fireEvent.click(page.getByRole("button", { name: "Вручную" }));
  fireEvent.click(page.getByRole("button", { name: "Бот" }));
  await waitFor(() =>
    assert.equal(
      (page.getByRole("button", { name: "Разрешить" }) as HTMLButtonElement)
        .disabled,
      true,
    ),
  );
  for (const button of page.getAllByRole("button", {
    name: "Тест",
  }))
    assert.equal((button as HTMLButtonElement).disabled, true);
  fireEvent.click(page.getByRole("button", { name: "Проверить" }));
  await waitFor(() => assert.ok(page.getByText(/Fixture server unavailable/)));
  assert.deepEqual(operations, ["conformance"]);
  fireEvent.click(page.getByRole("button", { name: "Журнал" }));
  assert.ok(page.getByText("bot:conformance"));
  fireEvent.click(page.getByRole("button", { name: "Очистить" }));
  assert.ok(page.getByText("Проверки ещё не запускались."));
  fireEvent.click(page.getByRole("button", { name: "Данные запуска" }));
  assert.ok(page.getByRole("heading", { name: /Данные запуска/ }));
});

test("run report separates confirmed device effects from API responses and exposes failures", async () => {
  versionsUnavailable();
  const report = {
    id: "fixture",
    startedAt: "2026-10-06T00:00:00Z",
    state: "finished" as const,
    checks: [
      {
        id: "native:device",
        label: "Device effect",
        group: "Bridge",
        bridge: "native",
        state: "passed" as const,
        evidence: "device" as const,
        detail: "Confirmed",
        durationMs: 20,
      },
      {
        id: "native:response",
        label: "API response",
        group: "Bridge",
        bridge: "native",
        state: "passed" as const,
        evidence: "response" as const,
        detail: "Accepted only",
        durationMs: 20,
      },
      {
        id: "native:failure",
        label: "Failed request",
        group: "Bridge",
        bridge: "native",
        state: "failed" as const,
        detail: "Fixture failure",
        durationMs: 20,
      },
      {
        id: "native:close",
        label: "Close application",
        group: "Bridge",
        bridge: "native",
        state: "manual" as const,
        detail: "Confirmation required",
        durationMs: 0,
      },
    ],
  };
  let exported = 0;
  const deferred: string[] = [];
  const page = render(
    <RunPage
      report={report}
      interaction={null}
      starting={false}
      stopping={false}
      exporting={false}
      onStart={() => {}}
      onStop={() => {}}
      onExport={() => {
        exported++;
      }}
      onDeferred={(id) => {
        deferred.push(id);
      }}
    />,
  );
  assert.ok(page.getByText("25%"));
  assert.ok(page.getByText("Fixture failure"));
  assert.equal(page.queryByText("API response"), null);
  fireEvent.click(page.getByRole("button", { name: "Все" }));
  assert.ok(page.getByText("API response"));
  assert.ok(page.getByText("Ответ API"));
  fireEvent.click(page.getByRole("button", { name: "Скачать отчёт" }));
  assert.equal(exported, 1);
  fireEvent.click(
    page.getByRole("button", { name: "native · Close application" }),
  );
  assert.deepEqual(deferred, ["native:close"]);
  await waitFor(() =>
    assert.ok(page.getByText("GitHub недоступен. Актуальность не проверена.")),
  );
});
