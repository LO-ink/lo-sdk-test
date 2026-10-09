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
      page.getByText(
        "Сначала автоматические проверки, затем действия с вашим подтверждением.",
      ),
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
        {
          label: "Подпись данных запуска",
          state: "skipped",
          detail: "Данные запуска не переданы",
        },
        {
          label: "Развернуть панель",
          state: "manual",
          bridge: "Нативный мост",
          detail: "Панель уже развёрнута; увеличение высоты проверить нельзя.",
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
    await expect(page.getByLabel("Шаг 6 из 6")).toHaveText("6 / 6");
    const heading = await page
      .getByRole("heading", { name: "Ход проверки" })
      .boundingBox();
    const step = await page.getByLabel("Шаг 6 из 6").boundingBox();
    expect(step!.x).toBeGreaterThanOrEqual(heading!.x + heading!.width);
    expect(step!.x + step!.width).toBeLessThanOrEqual(310);
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
    await expect(feed.getByText("Данные запуска не переданы")).toBeVisible();
    await expect(
      feed.getByText(
        "Панель уже развёрнута; увеличение высоты проверить нельзя.",
      ),
    ).toBeVisible();
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
          iconColor: getComputedStyle(element.querySelector(".feed-icon")!)
            .color,
          stateColor: getComputedStyle(element.querySelector(".feed-state")!)
            .color,
          expectedColor: getComputedStyle(element)
            .getPropertyValue(
              element.classList.contains("passed")
                ? "--lo-color-success"
                : element.classList.contains("failed")
                  ? "--lo-color-danger"
                  : "--lo-color-text-secondary",
            )
            .trim(),
        };
      });
      expect(geometry.width).toBe(266);
      expect(geometry.weight).toBe("400");
      expect(geometry.gap).toBeGreaterThanOrEqual(4);
      expect(geometry.aligned).toBe(true);
      expect(geometry.overflow).toBe(false);
      expect(geometry.iconColor).toBe(geometry.stateColor);
      // Resolve the inherited SDK token in the browser's computed color format.
      const expectedColor = await page.evaluate((color) => {
        const element = document.createElement("span");
        element.style.color = color;
        document.body.append(element);
        const computed = getComputedStyle(element).color;
        element.remove();
        return computed;
      }, geometry.expectedColor);
      expect(geometry.stateColor).toBe(expectedColor);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(320);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: resumed runs separate explanatory text from actions`, async ({
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
      ReactDOM.createRoot(host).render(
        React.createElement(RunPage, {
          report: {
            id: "spacing-fixture",
            startedAt: new Date().toISOString(),
            state: "cancelled",
            checks: [
              {
                id: "server",
                label: "Доступность сервера",
                group: "Запуск",
                state: "passed",
                detail: "",
                durationMs: 137,
                durationExecution: { build: null, unknown: "legacy" },
                evidence: "data",
              },
              {
                id: "audio",
                label: "Слышимость звука",
                group: "Запуск",
                state: "pending",
                detail: "",
                durationMs: 0,
              },
            ],
          },
          interaction: null,
          starting: false,
          stopping: false,
          exporting: false,
          onStart() {},
          onResume() {},
          onStop() {},
          onExport() {},
          onDeferred() {},
        }),
      );
    });
    const resume = page.getByRole("button", { name: "Продолжить проверку" });
    await expect(resume).toBeVisible();
    const note = page.getByText("Сохраним готовые результаты", {
      exact: false,
    });
    const restart = page.getByRole("button", { name: "Начать заново" });
    const exportButton = page.getByRole("button", { name: "Скачать отчёт" });
    const processed = page.getByText("Обработано 1 из 2 пунктов.");
    const gap = async (above: typeof note, below: typeof note) => {
      const a = (await above.boundingBox())!,
        b = (await below.boundingBox())!;
      return b.y - a.y - a.height;
    };
    expect(await gap(resume, note)).toBe(16);
    expect(await gap(note, restart)).toBe(16);
    expect(await gap(processed, exportButton)).toBe(16);
    expect((await restart.boundingBox())!.width).toBeLessThan(300);
    expect((await exportButton.boundingBox())!.width).toBeLessThan(268);
    await page
      .locator(".app:not([hidden])")
      .getByRole("button", { name: "Все", exact: true })
      .click();
    await page
      .locator("summary")
      .filter({ hasText: "Доступность сервера" })
      .click();
    const duration = page.getByText("0.14 с · Время первоначальной проверки");
    await expect(duration).toBeVisible();
    const box = (await duration.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await page.screenshot({
      path: `test-results/run-spacing-${scheme}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(320);
  });
}
