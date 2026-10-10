import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: shared disclosures retain keyboard access and noninteractive summaries at 320px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    await page.goto("/");
    const versions = page.locator(".sdk-versions");
    const summary = versions.locator("summary");
    await expect(versions).toHaveAttribute("open", "");
    await summary.focus();
    await summary.press("Enter");
    await expect(versions).not.toHaveAttribute("open", "");
    await summary.press("Space");
    await expect(versions).toHaveAttribute("open", "");
    await expect(versions.locator(".lo-ui-disclosure__chevron")).toHaveCount(1);
    await expect(
      summary.locator("button, a, input, select, textarea"),
    ).toHaveCount(0);
    await page.getByRole("tab", { name: "UI", exact: true }).click();
    const demo = page.getByRole("region", { name: "Disclosure", exact: true });
    const disclosure = demo.locator("details");
    const label = demo.locator("summary");
    await expect(label).toContainText("Подробности проверки");
    await expect(label).toContainText("3 шага");
    await page.evaluate(() => document.fonts.ready);
    const metadata = await label
      .getByText("3 шага", { exact: true })
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const summary = element.closest("summary")!;
        return {
          lines: Array.from(range.getClientRects(), (rect) => rect.toJSON()),
          summary: summary.getBoundingClientRect().toJSON(),
          title: summary
            .querySelector(".lo-ui-disclosure__label")!
            .getBoundingClientRect()
            .toJSON(),
          chevron: summary
            .querySelector(".lo-ui-disclosure__chevron")!
            .getBoundingClientRect()
            .toJSON(),
        };
      });
    expect(metadata.lines).toHaveLength(1);
    const [line] = metadata.lines;
    expect(line.left).toBeGreaterThanOrEqual(metadata.summary.left);
    expect(line.right).toBeLessThanOrEqual(metadata.summary.right);
    expect(line.top).toBeGreaterThanOrEqual(metadata.summary.top);
    expect(line.bottom).toBeLessThanOrEqual(metadata.summary.bottom);
    expect(line.left).toBeGreaterThanOrEqual(metadata.title.right);
    expect(line.right).toBeLessThanOrEqual(metadata.chevron.left);
    await expect(
      label.locator("button, a, input, select, textarea"),
    ).toHaveCount(0);
    await expect(disclosure).not.toHaveAttribute("open", "");
    await label.focus();
    await label.press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    const action = demo.getByRole("button", { name: "Проверить действие" });
    await expect(action).toBeVisible();
    await action.click();
    await expect(disclosure).toHaveAttribute("open", "");
    await label.focus();
    await label.press("Space");
    await expect(action).not.toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await page.screenshot({
      path: test.info().outputPath(`disclosure-${scheme}.png`),
      fullPage: true,
    });
  });
}

for (const phase of ["running", "cancelled"] as const) {
  test(`${phase}: shared run disclosures preserve history, filters and report content`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    await page.goto("/");
    await page.evaluate(async (state) => {
      const reactPath = "/node_modules/.vite/deps/react.js";
      const domPath = "/node_modules/.vite/deps/react-dom_client.js";
      const pagePath = "/web/RunPage.tsx";
      const { default: React } = await import(/* @vite-ignore */ reactPath);
      const { default: ReactDOM } = await import(/* @vite-ignore */ domPath);
      const { RunPage } = await import(/* @vite-ignore */ pagePath);
      document.querySelector<HTMLElement>(".app")!.hidden = true;
      const host = document.createElement("div");
      host.className = "app lo-ui-root";
      host.id = "disclosure-run-fixture";
      document.body.append(host);
      const checks = Array.from({ length: 9 }, (_, index) => ({
        id: `disclosure-${index}`,
        group: "Disclosure fixture",
        label: `Check ${index}`,
        detail: `Retained detail ${index}`,
        durationMs: 125,
        state:
          index === 8 && state === "running"
            ? "running"
            : index === 0
              ? "failed"
              : "passed",
      }));
      ReactDOM.createRoot(host).render(
        React.createElement(RunPage, {
          report: {
            id: "disclosure-fixture",
            startedAt: new Date().toISOString(),
            state,
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
    }, phase);
    const fixture = page.locator("#disclosure-run-fixture");
    if (phase === "running") {
      const history = fixture.locator("details").filter({
        has: page.locator("summary", { hasText: "Предыдущие шаги · 2" }),
      });
      await expect(history).toHaveClass(/lo-ui-disclosure/);
      await expect(
        history.getByText("Check 0", { exact: true }),
      ).not.toBeVisible();
      await history.locator("summary").focus();
      await history.locator("summary").press("Enter");
      await expect(history.getByText("Check 0", { exact: true })).toBeVisible();
      await expect(history.locator(".run-feed > li")).toHaveCount(2);
    } else {
      await expect(fixture.locator(".run-check")).toHaveCount(1);
      await fixture.getByRole("button", { name: "Все", exact: true }).click();
      await expect(fixture.locator(".run-check")).toHaveCount(9);
      const check = fixture.locator(".run-check.failed");
      await expect(check).toHaveClass(/lo-ui-disclosure/);
      await expect(check.locator("summary")).toContainText("Check 0");
      await expect(check.locator("summary")).toContainText("Ошибка");
      await expect(check.locator("summary button, summary a")).toHaveCount(0);
      await check.locator("summary").click();
      await expect(check.getByText("Retained detail 0")).toBeVisible();
      await expect(check.getByText("0.13 с", { exact: true })).toBeVisible();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
  });
}
