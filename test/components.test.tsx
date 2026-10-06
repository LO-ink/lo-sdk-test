import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import type { RunReport } from "../web/runner.ts";
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
  assert.ok(
    page
      .getByRole("button", { name: "Отмена" })
      .classList.contains("lo-ui-button--secondary"),
  );
  assert.ok(
    page
      .getByRole("button", { name: "Продолжить" })
      .classList.contains("lo-ui-button--primary"),
  );
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
  assert.ok(start.classList.contains("lo-ui-button"));
  assert.ok(
    page.getByLabelText("Text").classList.contains("lo-ui-field__input"),
  );
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

test("stored consent never authorizes a fresh user's session", async () => {
  const posts: { path: string; body: unknown }[] = [];
  const hostCalls: string[] = [];
  Object.assign(globalThis, {
    LO: {
      MiniAppNative: {
        protocolVersion: 1,
        generation: "fixture:document",
        operations: [],
        capabilities: [],
        launchData: new URLSearchParams({
          app_id: "demo",
          user: JSON.stringify({ id: "202" }),
          auth_date: String(Math.floor(Date.now() / 1000)),
        }).toString(),
        snapshot: () => ({ colorScheme: "light" }),
        subscribe: () => () => {},
        postMessage: (raw: string) => {
          hostCalls.push((JSON.parse(raw) as { operation: string }).operation);
        },
      },
    },
  });
  localStorage.setItem(
    "sdk-test.pending-consent",
    JSON.stringify({ appId: "demo", allowed: true }),
  );
  globalThis.fetch = async (input, options) => {
    const path = String(input);
    if (path.endsWith("/status"))
      return Response.json({ appConfigured: true, botConfigured: true });
    if (options?.method === "POST")
      posts.push({ path, body: JSON.parse(String(options.body)) });
    if (path.endsWith("/session"))
      return Response.json({ verified: true, appId: "demo", userId: "202" });
    return Response.json({}, { status: 503 });
  };
  try {
    const page = render(<App />);
    fireEvent.click(page.getByRole("button", { name: "Вручную" }));
    fireEvent.click(page.getByRole("button", { name: "Данные запуска" }));
    await waitFor(() =>
      assert.equal(
        (
          page.getByRole("button", {
            name: "Проверить подпись",
          }) as HTMLButtonElement
        ).disabled,
        false,
      ),
    );
    fireEvent.click(page.getByRole("button", { name: "Проверить подпись" }));
    await waitFor(() =>
      assert.equal(
        posts.filter((post) => post.path.endsWith("/session")).length,
        1,
      ),
    );
    assert.equal(
      posts.filter((post) => post.path.endsWith("/consent")).length,
      0,
    );
    assert.equal(hostCalls.includes("requestWriteAccess"), false);
  } finally {
    cleanup();
    Reflect.deleteProperty(globalThis, "LO");
  }
});

test("a stopped guided run reopens with Continue, preserves completed rows and can stop again", async () => {
  globalThis.fetch = async (input) =>
    String(input).endsWith("/status")
      ? Response.json({ appConfigured: true, botConfigured: false })
      : Response.json({}, { status: 503 });
  let page = render(<App />);
  fireEvent.click(page.getByRole("button", { name: "Проверить все мосты" }));
  await waitFor(() => assert.ok(page.getByText("Звук")));
  fireEvent.click(page.getByRole("button", { name: "Остановить проверку" }));
  await waitFor(() =>
    assert.ok(page.getByRole("button", { name: "Продолжить проверку" })),
  );
  const before = JSON.parse(localStorage.getItem("sdk-test.last-run")!)
    .report as import("../web/runner.ts").RunReport;
  assert.equal(before.state, "cancelled");
  const first = before.checks.find((check) => check.id === "server")!;
  assert.equal(first.state, "passed");
  page.unmount();
  page = render(<App />);
  assert.ok(page.getByRole("button", { name: "Начать заново" }));
  fireEvent.click(page.getByRole("button", { name: "Продолжить проверку" }));
  await waitFor(() => assert.ok(page.getByText("Звук")));
  const resumed = JSON.parse(localStorage.getItem("sdk-test.last-run")!)
    .report as import("../web/runner.ts").RunReport;
  assert.equal(resumed.id, before.id);
  assert.equal(resumed.startedAt, before.startedAt);
  assert.deepEqual(
    resumed.checks.find((check) => check.id === "server"),
    first,
  );
  assert.equal(
    resumed.checks.find((check) => check.id === "audio-playback")?.state,
    "running",
  );
  assert.equal(
    page.queryByRole("button", { name: "Продолжить проверку" }),
    null,
  );
  fireEvent.click(page.getByRole("button", { name: "Остановить проверку" }));
  await waitFor(() =>
    assert.ok(page.getByRole("button", { name: "Продолжить проверку" })),
  );
});

test("a crash-restored cleanup ledger prevents replacing the run even without a failed cleanup flag", async () => {
  versionsUnavailable();
  const report: RunReport = {
    id: "11111111-1111-4111-8111-111111111111",
    startedAt: new Date().toISOString(),
    state: "cancelled",
    checks: [
      {
        id: "next",
        label: "Next",
        group: "fixture",
        state: "cancelled",
        detail: "Interrupted",
        durationMs: 1,
      },
    ],
    recovery: {
      native: {
        key: "lo-sdk-run-11111111-1111-4111-8111-111111111111-native",
        written: [],
        mutations: ["startAccelerometer"],
        original: {},
      },
    },
  };
  let started = 0;
  let continued = 0;
  const page = render(
    <RunPage
      report={report}
      interaction={null}
      starting={false}
      stopping={false}
      exporting={false}
      onStart={() => {
        started++;
      }}
      onResume={() => {
        continued++;
      }}
      onStop={() => {}}
      onExport={() => {}}
      onDeferred={() => {}}
    />,
  );
  fireEvent.click(page.getByRole("button", { name: "Начать заново" }));
  assert.equal(started, 0);
  assert.equal(
    (page.getByRole("button", { name: "Начать заново" }) as HTMLButtonElement)
      .disabled,
    true,
  );
  fireEvent.click(page.getByRole("button", { name: "Продолжить проверку" }));
  assert.equal(continued, 1);
});

const { UiPage } = await import("../web/UiPage.tsx");
const publicUi = await import("@lo-ink/ui");
test("the UI catalog covers all public primitives with local, isolated interactions", () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("Catalog must stay local");
  };
  const hostTheme = document.documentElement.dataset.loTheme;
  const page = render(<UiPage />);
  for (const name of [
    "Button",
    "TextField",
    "Switch · Checkbox",
    "List · Cell",
    "AppIcon",
    "Heading · Text",
    "EmptyState",
    "Stack · Inline",
  ])
    assert.ok(page.getByRole("region", { name }));
  const demonstrated = [
    ...page.container.querySelectorAll(".ui-demo > h3"),
  ].flatMap((heading) => heading.textContent!.split(" · "));
  assert.deepEqual(demonstrated.sort(), Object.keys(publicUi).sort());
  fireEvent.click(page.getByRole("button", { name: "Тёмная" }));
  const catalog = page
    .getByRole("heading", { name: "UI компоненты" })
    .closest(".ui-catalog") as HTMLElement;
  assert.equal(catalog.dataset.loTheme, "dark");
  assert.equal(document.documentElement.dataset.loTheme, hostTheme);
  fireEvent.click(page.getByRole("button", { name: "Светлая" }));
  assert.equal(catalog.dataset.loTheme, "light");
  fireEvent.click(page.getByRole("button", { name: "Как в LO" }));
  assert.equal(catalog.dataset.loTheme, undefined);
  assert.equal(catalog.classList.contains("lo-ui-root"), false);
  for (const name of [
    "primary",
    "secondary",
    "danger",
    "quiet",
    "Маленькая",
    "С иконкой",
    "Кнопка на всю ширину с длинным названием",
  ])
    fireEvent.click(page.getByRole("button", { name }));
  assert.ok(page.getByText("Нажатий: 7"));
  const field = page.getByRole("textbox", { name: "Название" });
  fireEvent.change(field, { target: { value: "x" } });
  assert.equal(field.getAttribute("aria-invalid"), "true");
  fireEvent.change(field, { target: { value: "Example" } });
  assert.equal(field.getAttribute("aria-invalid"), null);
  fireEvent.click(page.getByRole("switch", { name: "Уведомления" }));
  assert.equal(
    (
      page.getByRole("switch", {
        name: "Уведомления в строке",
      }) as HTMLInputElement
    ).checked,
    false,
  );
  fireEvent.click(page.getByRole("switch", { name: "Уведомления в строке" }));
  fireEvent.click(page.getByRole("checkbox", { name: "Закрытый список" }));
  assert.equal(
    (
      page.getByRole("checkbox", {
        name: "Закрытый список в строке",
      }) as HTMLInputElement
    ).checked,
    true,
  );
  fireEvent.click(
    page.getByRole("checkbox", { name: "Закрытый список в строке" }),
  );
  fireEvent.click(page.getByRole("button", { name: /Открыть пример/ }));
  fireEvent.click(page.getByRole("button", { name: "Отдельное действие" }));
  fireEvent.click(page.getByRole("button", { name: "Выбрать" }));
  assert.ok(page.getByText("Нажатий: 10"));
  fireEvent.click(page.getByRole("button", { name: "Создать пример" }));
  assert.ok(page.getByText("Пример создан"));
  fireEvent.click(
    page.getByRole("button", { name: "Показать пустое состояние" }),
  );
  assert.ok(page.getByRole("heading", { name: "Пока ничего нет" }));
  assert.equal(
    (
      page.getByRole("checkbox", {
        name: "Отключённый checkbox: выбран",
      }) as HTMLInputElement
    ).disabled,
    true,
  );
  assert.equal(
    (page.getByRole("textbox", { name: "Только чтение" }) as HTMLInputElement)
      .readOnly,
    true,
  );
  assert.equal(requests, 0);
});

test("the application exposes the UI page separately from manual checks", async () => {
  versionsUnavailable();
  const page = render(<App />);
  fireEvent.click(page.getByRole("button", { name: "UI" }));
  assert.ok(page.getByRole("heading", { name: "UI компоненты" }));
  assert.equal(page.queryByRole("group", { name: "Ручные проверки" }), null);
  assert.equal(
    page.getByRole("button", { name: "UI" }).getAttribute("aria-current"),
    "page",
  );
  fireEvent.click(page.getByRole("button", { name: "Вручную" }));
  assert.ok(page.getByRole("group", { name: "Ручные проверки" }));
});
