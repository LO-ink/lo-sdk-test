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
  fireEvent.click(page.getByRole("tab", { name: "Вручную" }));
  fireEvent.click(page.getByRole("tab", { name: "Бот" }));
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
  fireEvent.click(page.getByRole("tab", { name: "Журнал" }));
  assert.ok(page.getByText("bot:conformance"));
  fireEvent.click(page.getByRole("button", { name: "Очистить" }));
  assert.ok(page.getByText("Проверки ещё не запускались."));
  fireEvent.click(page.getByRole("tab", { name: "Данные запуска" }));
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
    fireEvent.click(page.getByRole("tab", { name: "Вручную" }));
    fireEvent.click(page.getByRole("tab", { name: "Данные запуска" }));
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
    "TextArea",
    "Dialog",
    "Progress",
    "Surface",
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
  const modal = page
    .getByRole("region", { name: "Dialog" })
    .querySelector("dialog")!;
  fireEvent.click(page.getByRole("button", { name: "Открыть диалог" }));
  assert.equal(modal.open, true);
  fireEvent.click(page.getByRole("button", { name: "Закрыть диалог" }));
  assert.equal(modal.open, false);
  assert.equal(requests, 0);
});

test("the application exposes the UI page separately from manual checks", async () => {
  versionsUnavailable();
  const page = render(<App />);
  fireEvent.click(page.getByRole("tab", { name: "UI" }));
  assert.ok(page.getByRole("heading", { name: "UI компоненты" }));
  assert.equal(page.queryByRole("tablist", { name: "Ручные проверки" }), null);
  assert.equal(
    page.getByRole("tab", { name: "UI" }).getAttribute("aria-selected"),
    "true",
  );
  fireEvent.click(page.getByRole("tab", { name: "Вручную" }));
  assert.ok(page.getByRole("tablist", { name: "Ручные проверки" }));
});

test("Secretary first proposal is explicit and review receipt does not claim sent", async () => {
  const { SecretaryPage } = await import("../web/SecretaryPage.tsx");
  const calls: unknown[] = [];
  const flow = {
    configured: true,
    runId: "synthetic-run",
    botId: "1000000000000042",
    ownerId: "17",
    peerId: "42",
    connectionVerified: true,
    incomingReceived: true,
    reply: "Synthetic review reply",
    attempted: false,
  };
  const page = render(
    <SecretaryPage
      authenticated
      request={async (_path, body) => {
        calls.push(body);
        return calls.length === 1
          ? flow
          : {
              ...flow,
              attempted: true,
              outcome: "received",
              draft: { state: "draft" },
            };
      }}
    />,
  );
  const create = await page.findByRole("button", {
    name: "Создать черновик для проверки в LO",
  });
  assert.equal(
    page.queryByRole("button", { name: "Повторить точный запрос" }),
    null,
  );
  assert.equal(
    page.queryByText("Одобрение и отправка подтверждены сервером"),
    null,
  );
  fireEvent.click(create);
  await page.findByText("Черновик подтверждён сервером");
  assert.deepEqual(calls[1], { action: "propose", runId: "synthetic-run" });
  assert.equal(
    page.queryByText("Одобрение и отправка подтверждены сервером"),
    null,
  );
});

test("Secretary unknown outcome offers only same-key retry and signout hides pending results", async () => {
  const { SecretaryPage } = await import("../web/SecretaryPage.tsx");
  const flow = {
    configured: true,
    runId: "synthetic-run",
    incomingReceived: true,
    attempted: true,
    outcome: "unavailable",
  };
  let finish: ((value: typeof flow) => void) | undefined;
  const request = async (_path: string, body: unknown) =>
    (body as { action: string }).action === "status"
      ? flow
      : new Promise<typeof flow>((resolve) => {
          finish = resolve;
        });
  const page = render(<SecretaryPage authenticated request={request} />);
  fireEvent.click(
    await page.findByRole("button", { name: "Повторить точный запрос" }),
  );
  page.rerender(<SecretaryPage authenticated={false} request={request} />);
  finish?.(flow);
  await waitFor(() =>
    assert.equal(
      page.queryByText("Предлагаемый ответ в этот же тестовый диалог:"),
      null,
    ),
  );
});

test("a first lost Secretary proposal response becomes an uncertain same-key retry", async () => {
  const { SecretaryPage } = await import("../web/SecretaryPage.tsx");
  const flow = {
    configured: true,
    runId: "synthetic-run",
    incomingReceived: true,
    attempted: false,
  };
  let attempted = false;
  const request = async (_path: string, body: unknown) => {
    if ((body as { action: string }).action === "propose") {
      attempted = true;
      throw new Error("Synthetic lost response");
    }
    return attempted
      ? { ...flow, attempted: true, outcome: "unavailable" }
      : flow;
  };
  const page = render(<SecretaryPage authenticated request={request} />);
  fireEvent.click(
    await page.findByRole("button", {
      name: "Создать черновик для проверки в LO",
    }),
  );
  await page.findByRole("button", { name: "Повторить точный запрос" });
  await page.findByText(/Результат сейчас неизвестен/);
  assert.equal(
    page.queryByRole("button", { name: "Создать черновик для проверки в LO" }),
    null,
  );
  assert.equal(
    page.queryByText("Одобрение и отправка подтверждены сервером"),
    null,
  );
});

test("launch details expose every typed value without signatures or raw credentials", async () => {
  const { LaunchDetails } = await import("../web/LaunchDetails.tsx");
  const page = render(
    <LaunchDetails
      authenticated={false}
      locale="ru"
      launch={{
        user: {
          id: "17",
          firstName: "Test",
          lastName: "Person",
          username: "synthetic",
          photoUrl: "https://cdn.lo.ink/test.jpg",
          languageCode: "en",
        },
        startParam: "resume",
        chatType: "private",
        authDate: 123,
        appId: "test-app",
        queryId: "test-query",
      }}
    />,
  );
  for (const value of [
    "17",
    "ru",
    "Test",
    "Person",
    "synthetic",
    "https://cdn.lo.ink/test.jpg",
    "en",
    "resume",
    "private",
    "123",
    "test-app",
    "test-query",
    "Не проверена",
  ])
    assert.ok(page.getByText(value, { exact: true }));
  assert.equal(page.container.querySelectorAll("img, a").length, 0);
  page.rerender(
    <LaunchDetails authenticated launch={{ user: { id: "17" } }} />,
  );
  assert.equal(page.getAllByText("Не передано").length, 11);
  assert.ok(page.getByText("Проверена"));
});

test("tab swipes change adjacent sections but preserve vertical scrolling and controls", async () => {
  const { useTabSwipe } = await import("../web/use-tab-swipe.ts");
  const { useState } = await import("react");
  const changes: string[] = [];
  function Example({ disabled = false }: { disabled?: boolean }) {
    const [value, setValue] = useState("checks");
    const swipe = useTabSwipe({
      value,
      values: ["checks", "manual", "ui"],
      disabled,
      onChange: (next) => {
        changes.push(next);
        setValue(next);
      },
    });
    return (
      <main {...swipe}>
        <p>Swipe here</p>
        <button>Keep action</button>
        <input aria-label="Keep input" />
        <label>
          <span>Keep label</span>
          <input type="checkbox" />
        </label>
        <details>
          <summary>
            <span>Keep summary</span>
          </summary>
        </details>
        <div role="button">
          <span>Keep role action</span>
        </div>
        <div tabIndex={0}>
          <span>Keep focus target</span>
        </div>
        <div data-testid="scroller" style={{ overflowX: "auto" }}>
          Scrollable
        </div>
        <span>{value}</span>
      </main>
    );
  }
  const page = render(<Example />);
  const target = page.getByText("Swipe here");
  const pointer = (
    type: string,
    element: Element,
    x: number,
    y: number,
    props = {},
  ) => {
    const event = new dom.window.MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      isPrimary: { value: true },
      pointerType: { value: "pen" },
      ...Object.fromEntries(
        Object.entries(props).map(([key, value]) => [key, { value }]),
      ),
    });
    fireEvent(element, event);
  };
  const swipe = (element = target, dx = -100, dy = 0, props = {}) => {
    pointer("pointerdown", element, 200, 100, props);
    pointer("pointermove", element, 200 + dx, 100 + dy, props);
    pointer("pointerup", element, 200 + dx, 100 + dy, props);
  };
  swipe();
  assert.deepEqual(changes, ["manual"]);
  swipe(target, -100, 120);
  swipe(target, -30);
  swipe(page.getByRole("button", { name: "Keep action" }));
  swipe(page.getByRole("textbox"));
  swipe(page.getByText("Keep label"));
  swipe(page.getByText("Keep summary"));
  swipe(page.getByText("Keep role action"));
  swipe(page.getByText("Keep focus target"));
  swipe(target, -100, 0, { pointerType: "mouse" });
  swipe(target, -100, 0, { isPrimary: false });
  assert.deepEqual(changes, ["manual"]);
  const scroller = page.getByTestId("scroller");
  Object.defineProperties(scroller, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 200 },
  });
  swipe(scroller);
  assert.deepEqual(changes, ["manual"]);
  pointer("pointerdown", target, 200, 100);
  pointer("pointercancel", target, 100, 100);
  pointer("pointerup", target, 100, 100);
  assert.deepEqual(changes, ["manual"]);
  swipe(target, -100, 0, { pointerType: "pen" });
  assert.deepEqual(changes, ["manual", "ui"]);
  swipe();
  assert.deepEqual(changes, ["manual", "ui"]);
  swipe(target, 100);
  assert.deepEqual(changes, ["manual", "ui", "manual"]);
  page.rerender(<Example disabled />);
  swipe();
  assert.deepEqual(changes, ["manual", "ui", "manual"]);
});

test("touch ownership preserves controls, scrolling, cancellation and pinch gestures", async () => {
  const { useTabSwipe } = await import("../web/use-tab-swipe.ts");
  const changes: string[] = [];
  function Example({ disabled = false }: { disabled?: boolean }) {
    const swipe = useTabSwipe({
      value: "checks",
      values: ["checks", "manual", "ui"],
      disabled,
      onChange: (value) => changes.push(value),
    });
    return (
      <main {...swipe}>
        <p>Touch content</p>
        <label>
          <span>Touch control</span>
          <input type="checkbox" />
        </label>
        <pre style={{ overflowX: "auto" }}>Touch scroller</pre>
      </main>
    );
  }
  const page = render(<Example />);
  const target = page.getByText("Touch content");
  const touch = (
    type: string,
    x: number,
    y: number,
    element = target,
    count = 1,
    cancelable = true,
  ) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable });
    const item = { identifier: 1, clientX: x, clientY: y };
    Object.defineProperties(event, {
      touches: {
        value:
          type === "touchend"
            ? []
            : Array.from({ length: count }, (_, i) => ({
                ...item,
                identifier: i + 1,
              })),
      },
      changedTouches: { value: [item] },
    });
    fireEvent(element, event);
    return event.defaultPrevented;
  };
  touch("touchstart", 200, 100);
  assert.equal(touch("touchmove", 100, 105), true);
  touch("touchend", 100, 105);
  assert.deepEqual(changes, ["manual"]);
  for (const element of [
    page.getByText("Touch control"),
    page.getByText("Touch scroller"),
  ]) {
    if (element.tagName === "PRE")
      Object.defineProperties(element, {
        clientWidth: { value: 100 },
        scrollWidth: { value: 200 },
      });
    touch("touchstart", 200, 100, element);
    assert.equal(touch("touchmove", 100, 100, element), false);
    touch("touchend", 100, 100, element);
  }
  touch("touchstart", 200, 100);
  assert.equal(touch("touchmove", 190, 200), false);
  touch("touchend", 100, 200);
  touch("touchstart", 200, 100);
  touch("touchcancel", 100, 100);
  touch("touchend", 100, 100);
  touch("touchstart", 200, 100);
  assert.equal(touch("touchmove", 100, 100, target, 2), false);
  touch("touchend", 100, 100);
  touch("touchstart", 200, 100, target, 2);
  touch("touchend", 100, 100);
  touch("touchstart", 200, 100);
  assert.equal(touch("touchmove", 100, 100, target, 1, false), false);
  touch("touchend", 100, 100);
  page.rerender(<Example disabled />);
  touch("touchstart", 200, 100);
  touch("touchmove", 100, 100);
  touch("touchend", 100, 100);
  assert.deepEqual(changes, ["manual"]);
  page.unmount();
  touch("touchstart", 200, 100);
  touch("touchmove", 100, 100);
  touch("touchend", 100, 100);
  assert.deepEqual(changes, ["manual"]);
});
