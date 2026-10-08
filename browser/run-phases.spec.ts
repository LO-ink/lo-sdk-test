import { expect, test } from "@playwright/test";

for (const selected of ["native"] as const) {
  test(`${selected}: all automatic work finishes before a single selected-bridge permission action`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.addInitScript(() => {
      const calls: string[] = [];
      const listeners = new Set<(raw: string) => void>();
      const launchData = new URLSearchParams({
        app_id: "fixture",
        user: JSON.stringify({ id: "fixture" }),
        auth_date: String(Math.floor(Date.now() / 1000)),
      }).toString();
      Object.assign(window, {
        phaseFixtureCalls: calls,
        LO: {
          MiniAppNative: {
            protocolVersion: 1,
            generation: "phase-fixture",
            operations: ["ready", "requestWriteAccess", "haptic"],
            capabilities: ["ready", "requestWriteAccess", "haptics"],
            launchData,
            snapshot: () => ({
              colorScheme: "light",
              safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
              contentSafeArea: { top: 0, right: 0, bottom: 0, left: 0 },
            }),
            subscribe: (listener: (raw: string) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            postMessage: (raw: string) => {
              const message = JSON.parse(raw);
              if (message.kind !== "request") return;
              calls.push(`native:${message.operation}`);
              for (const listener of listeners)
                listener(
                  JSON.stringify({
                    channel: "lo.miniapp",
                    version: 1,
                    generation: "phase-fixture",
                    kind: "result",
                    id: message.id,
                    ok: true,
                    value:
                      message.operation === "requestWriteAccess"
                        ? true
                        : undefined,
                  }),
                );
            },
          },
          get WebApp() {
            throw new Error(
              "The native app must never access an obsolete host route",
            );
          },
        },
      });
    });
    const apiCalls: string[] = [];
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON() ?? {};
      if (path === "/api/bot") apiCalls.push(body.operation);
      await route.fulfill({
        status: 200,
        json:
          path === "/api/status"
            ? { appConfigured: true, botConfigured: true }
            : path === "/api/session"
              ? { verified: true, appId: "fixture", userId: "fixture" }
              : path === "/api/bot"
                ? body.operation === "conformance"
                  ? {
                      mode: "synthetic",
                      networkCalls: 0,
                      results: Array.from({ length: 14 }, () => ({
                        test: "fixture",
                        passed: true,
                      })),
                    }
                  : { mode: "live", result: { known: true } }
                : {},
      });
    });
    await page.goto("/");
    await expect(
      page.getByRole("tablist", { name: "Мост интерактивных проверок" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Начать проверку" }).click();
    await expect(
      page.getByRole("button", { name: "Запросить разрешение" }),
    ).toBeVisible({ timeout: 20000 });
    const before = await page.evaluate(() => ({
      calls: (window as unknown as { phaseFixtureCalls: string[] })
        .phaseFixtureCalls,
      report: JSON.parse(localStorage.getItem("sdk-test.last-run")!).report,
    }));
    expect(before.calls).toContain("native:ready");
    expect(
      before.calls.every((call: string) => call.startsWith("native:")),
    ).toBe(true);
    expect(
      before.calls.some((call) => call.endsWith("requestWriteAccess")),
    ).toBe(false);
    expect(before.report.assistedBridge).toBeUndefined();
    expect(
      before.report.checks
        .filter(
          (check: { phase: string; state: string }) =>
            check.phase === "automatic",
        )
        .every(
          (check: { state: string }) =>
            !["pending", "running", "cancelled"].includes(check.state),
        ),
    ).toBe(true);
    expect(apiCalls).toEqual([
      "conformance",
      "getIdentity",
      "getCapabilities",
      "getCommands",
    ]);
    await expect(
      page.getByText("Проверки с вашим участием", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/phases-${selected}-assisted.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Запросить разрешение" }).click();
    await expect(
      page.getByRole("button", { name: "Воспроизвести", exact: true }),
    ).toBeVisible();
    const after = await page.evaluate(
      () =>
        (window as unknown as { phaseFixtureCalls: string[] })
          .phaseFixtureCalls,
    );
    expect(after.filter((call) => call.endsWith("requestWriteAccess"))).toEqual(
      [`${selected}:requestWriteAccess`],
    );
    await page
      .getByRole("button", { name: "Остановить проверку", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Продолжить проверку" }),
    ).toBeVisible();
    await expect(
      page.getByRole("tablist", { name: "Мост интерактивных проверок" }),
    ).toHaveCount(0);
    await page.reload();
    await page
      .getByRole("button", { name: "Начать заново", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Запросить разрешение" }),
    ).toBeVisible({ timeout: 20000 });
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("sdk-test.last-run")!).report
            .assistedBridge,
      ),
    ).toBeUndefined();
    await page
      .getByRole("button", { name: "Остановить проверку", exact: true })
      .click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(320);
  });
}
