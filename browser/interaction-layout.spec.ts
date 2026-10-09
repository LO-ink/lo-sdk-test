import { expect, test } from "@playwright/test";

for (const width of [320, 402]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: all confirmation actions fit and work at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 720 });
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
        const componentPath = "/web/RunInteraction.tsx";
        const { default: React } = await import(/* @vite-ignore */ reactPath);
        const { default: ReactDOM } = await import(/* @vite-ignore */ domPath);
        const { RunInteraction } = await import(
          /* @vite-ignore */ componentPath
        );
        document.querySelector<HTMLElement>(".app")!.hidden = true;
        const host = document.createElement("div");
        host.className = "app lo-ui-root";
        host.dataset.testid = "confirmation-fixture";
        host.dataset.actions = "";
        document.body.append(host);
        const record = (value: string) => {
          host.dataset.actions += `${value},`;
        };
        ReactDOM.createRoot(host).render(
          React.createElement(RunInteraction, {
            view: {
              title: "Проверка звука",
              detail: "Подтвердите результат",
              question: "Слышен звук?",
              phase: "confirm",
              attempt: 1,
              action: async () => {},
              answer: record,
              repeat: () => record("repeat"),
            },
            onStop: () => record("stop"),
          }),
        );
        await document.fonts.ready;
      });
      const fixture = page.getByTestId("confirmation-fixture");
      await expect(fixture.getByRole("button")).toHaveCount(5);
      await page.evaluate(() => document.fonts.ready);
      const bounds = (await fixture.locator(".run-interaction").boundingBox())!;
      for (const button of await fixture.getByRole("button").all()) {
        const rect = (await button.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
        expect(rect.x + rect.width).toBeLessThanOrEqual(
          bounds.x + bounds.width,
        );
        expect(rect.y + rect.height).toBeLessThanOrEqual(
          bounds.y + bounds.height,
        );
        expect(rect.height).toBeGreaterThanOrEqual(44);
        // Clipping can pass both toBeVisible and document-overflow checks.
        expect(
          await button.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return element.contains(
              document.elementFromPoint(
                rect.right - 2,
                rect.top + rect.height / 2,
              ),
            );
          }),
        ).toBe(true);
      }
      await fixture.screenshot({
        path: test.info().outputPath("confirmation.png"),
      });
      for (const name of [
        "Да",
        "Нет",
        "Повторить действие",
        "Пропустить",
        "Остановить",
      ])
        await fixture.getByRole("button", { name, exact: true }).click();
      await expect(fixture).toHaveAttribute(
        "data-actions",
        "yes,no,repeat,skip,stop,",
      );
    });
  }
}
