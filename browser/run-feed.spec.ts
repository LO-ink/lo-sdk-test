import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: run statuses leave full title width at 320px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Начать проверку" }),
    ).toBeVisible();
    await expect(
      page.getByText("Автоматические шаги и действия с вашим подтверждением."),
    ).toBeVisible();
    await page.evaluate(async () => {
      const reactPath = "/node_modules/.vite/deps/react.js";
      const domPath = "/node_modules/.vite/deps/react-dom_client.js";
      const pagePath = "/web/RunPage.tsx";
      const { default: React } = await import(/* @vite-ignore */ reactPath);
      const { default: ReactDOM } = await import(/* @vite-ignore */ domPath);
      const { RunPage } = await import(/* @vite-ignore */ pagePath);
      document.querySelector<HTMLElement>(".app")!.hidden = true;
      const host = document.createElement("div");
      host.className = "app lo-ui-root";
      document.body.append(host);
      const checks = [
        {
          label: "Доступность сервера и настройки приложения",
          state: "passed",
          evidence: "data",
        },
        { label: "Подпись данных запуска", state: "skipped" },
        {
          label: "Разрешение на сообщения бота",
          state: "manual",
          bridge: "Нативный мост",
        },
        {
          label: "Ответ на тестовый запрос",
          state: "passed",
          evidence: "response",
        },
        {
          label: "Запись в защищённое хранилище",
          state: "failed",
          detail: "LO отклонил запись",
        },
        { label: "Слышимость звука", state: "running" },
      ].map((check, index) => ({
        id: String(index),
        group: "Запуск",
        detail: "",
        durationMs: 0,
        ...check,
      }));
      ReactDOM.createRoot(host).render(
        React.createElement(RunPage, {
          report: {
            id: "fixture",
            startedAt: new Date().toISOString(),
            state: "running",
            checks,
          },
          interaction: null,
          starting: false,
          stopping: false,
          exporting: false,
          onStart() {},
          onStop() {},
          onExport() {},
          onDeferred() {},
        }),
      );
    });
    const feed = page.locator(".run-feed");
    await expect(feed.getByRole("listitem")).toHaveCount(6);
    await expect(feed.locator(".feed-title").first()).toHaveText(
      "Слышимость звука",
    );
    await expect(
      page.getByText("Слышимость звука", { exact: true }),
    ).toHaveCount(1);
    await expect(feed.locator(".feed-title").nth(1)).toHaveText(
      "Запись в защищённое хранилище",
    );
    for (const status of [
      "Подтверждено",
      "Пропущено",
      "Не проверено",
      "Ответ API",
      "Ошибка",
      "Проверяем",
    ])
      await expect(feed.getByText(status, { exact: true })).toBeVisible();
    await expect(feed.getByText("LO отклонил запись")).toBeVisible();
    for (const row of await feed.getByRole("listitem").all()) {
      const geometry = await row.evaluate((element) => {
        const title = element.querySelector<HTMLElement>(".feed-title")!;
        const meta = element.querySelector<HTMLElement>(".feed-meta")!;
        const titleBounds = title.getBoundingClientRect(),
          metaBounds = meta.getBoundingClientRect();
        return {
          width: titleBounds.width,
          weight: getComputedStyle(title).fontWeight,
          gap: metaBounds.top - titleBounds.bottom,
          aligned: metaBounds.left === titleBounds.left,
          overflow: element.scrollWidth > element.clientWidth,
        };
      });
      expect(geometry.width).toBe(266);
      expect(geometry.weight).toBe("400");
      expect(geometry.gap).toBeGreaterThanOrEqual(4);
      expect(geometry.aligned).toBe(true);
      expect(geometry.overflow).toBe(false);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(320);
  });
}
