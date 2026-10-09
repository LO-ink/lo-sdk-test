import { expect, test } from "@playwright/test";

for (const width of [320, 402]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: photo action stays compact at ${width}px without automatic navigation`, async ({
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
        const componentPath = "/web/LaunchDetails.tsx";
        const { default: React } = await import(/* @vite-ignore */ reactPath);
        const { default: ReactDOM } = await import(/* @vite-ignore */ domPath);
        const { LaunchDetails } = await import(
          /* @vite-ignore */ componentPath
        );
        document.querySelector<HTMLElement>(".app")!.hidden = true;
        const host = document.createElement("div");
        host.className = "app lo-ui-root";
        host.dataset.testid = "launch-fixture";
        host.dataset.opens = "0";
        document.body.append(host);
        ReactDOM.createRoot(host).render(
          React.createElement(LaunchDetails, {
            authenticated: false,
            locale: "ru",
            launch: {
              user: {
                id: "17",
                firstName: "Synthetic",
                photoUrl: `https://cdn.lo.ink/${"photo/".repeat(40)}test.jpg`,
              },
            },
            onOpenPhoto: (url: string) => {
              host.dataset.opens = String(Number(host.dataset.opens) + 1);
              host.dataset.openedHttps = String(url.startsWith("https://"));
            },
          }),
        );
        await document.fonts.ready;
      });
      const fixture = page.getByTestId("launch-fixture");
      const button = fixture.getByRole("button", {
        name: "Открыть фото пользователя",
      });
      await expect(button).toBeVisible();
      await expect(fixture).toHaveAttribute("data-opens", "0");
      await expect(fixture.locator("img, a")).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      const row = fixture
        .locator(".launch-details > div")
        .filter({ hasText: "Фото пользователя" });
      expect((await row.boundingBox())!.height).toBeLessThan(100);
      const rect = (await button.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(rect.height).toBeGreaterThanOrEqual(44);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await fixture.screenshot({
        path: test.info().outputPath("launch-details.png"),
      });
      await button.click();
      await expect(fixture).toHaveAttribute("data-opens", "1");
      await expect(fixture).toHaveAttribute("data-opened-https", "true");
    });
  }
}

for (const supported of [true, false]) {
  test(`actual App photo action ${supported ? "uses the native SDK and displays failure" : "stays disabled when unsupported"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.addInitScript(
      ({ supported }) => {
        const calls: { operation: string; input?: unknown }[] = [];
        const listeners = new Set<(raw: string) => void>();
        Object.assign(window, {
          photoFixtureCalls: calls,
          LO: {
            MiniAppNative: {
              protocolVersion: 1,
              generation: "photo-fixture",
              operations: supported ? ["openLink"] : [],
              capabilities: supported ? ["openLink"] : [],
              launchData: new URLSearchParams({
                app_id: "fixture",
                user: JSON.stringify({
                  id: "17",
                  photo_url: "https://cdn.lo.ink/test.jpg",
                }),
                auth_date: String(Math.floor(Date.now() / 1000)),
              }).toString(),
              snapshot: () => ({ colorScheme: "light" }),
              subscribe: (listener: (raw: string) => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
              },
              postMessage: (raw: string) => {
                const message = JSON.parse(raw);
                if (message.kind !== "request") return;
                calls.push({
                  operation: message.operation,
                  input: message.input,
                });
                for (const listener of listeners)
                  listener(
                    JSON.stringify({
                      channel: "lo.miniapp",
                      version: 1,
                      generation: "photo-fixture",
                      kind: "result",
                      id: message.id,
                      ok: false,
                      error: {
                        code: "host_error",
                        message: "Photo fixture refused",
                      },
                    }),
                  );
              },
            },
            get WebApp() {
              throw new Error("Photo action must use the native SDK");
            },
          },
        });
      },
      { supported },
    );
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    await page.goto("/");
    await page.getByRole("tab", { name: "Вручную", exact: true }).click();
    await page
      .getByRole("tab", { name: "Данные запуска", exact: true })
      .click();
    const button = page.getByRole("button", {
      name: "Открыть фото пользователя",
    });
    await expect(button).toBeVisible();
    expect(
      await page.evaluate(() => Reflect.get(window, "photoFixtureCalls")),
    ).toEqual([]);
    if (supported) {
      await button.click();
      await expect(
        page.getByText('"Photo fixture refused"', { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => Reflect.get(window, "photoFixtureCalls")),
      ).toEqual([
        {
          operation: "openLink",
          input: { url: "https://cdn.lo.ink/test.jpg" },
        },
      ]);
    } else {
      await expect(button).toBeDisabled();
    }
  });
}
