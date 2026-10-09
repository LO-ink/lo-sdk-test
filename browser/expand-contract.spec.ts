import { expect, test } from "@playwright/test";

for (const { width, mode } of [
  { width: 320, mode: "success" },
  { width: 402, mode: "success" },
  { width: 320, mode: "error" },
  { width: 320, mode: "unsupported" },
  { width: 320, mode: "late" },
])
  test(`canonical expand ${mode} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.addInitScript((mode) => {
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
            operations:
              mode === "unsupported" ? ["ready"] : ["ready", "expand"],
            capabilities:
              mode === "unsupported" ? ["ready"] : ["ready", "expand"],
            launchData,
            snapshot: () => ({
              colorScheme: "light",
              viewportHeight: 700,
              stableViewportHeight: 700,
              isFullscreen: true,
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
              if (message.operation === "expand" && mode === "late") return;
              for (const listener of listeners)
                listener(
                  JSON.stringify({
                    channel: "lo.miniapp",
                    version: 1,
                    generation: "phase-fixture",
                    kind: "result",
                    id: message.id,
                    ok: !(message.operation === "expand" && mode === "error"),
                    ...(message.operation === "expand" && mode === "error"
                      ? {
                          error: {
                            code: "host_error",
                            message: "Expansion fixture refused",
                          },
                        }
                      : {}),
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
    }, mode);
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
    await page
      .getByRole("button", { name: "Начать проверку", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Воспроизвести", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "Пропустить", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Начать проверку темы", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Пропустить", exact: true }).click();
    if (mode === "unsupported") {
      await expect
        .poll(async () =>
          page.evaluate(
            () =>
              JSON.parse(
                localStorage.getItem("sdk-test.last-run")!,
              ).report.checks.find(
                (c: { id: string }) => c.id === "native:expand",
              )?.state,
          ),
        )
        .toBe("skipped");
      expect(
        await page.evaluate(() =>
          (
            window as unknown as { phaseFixtureCalls: string[] }
          ).phaseFixtureCalls.includes("native:expand"),
        ),
      ).toBe(false);
      await expect(
        page.getByRole("button", { name: "Отправить запрос", exact: true }),
      ).toHaveCount(0);
      return;
    }
    await expect(
      page.getByRole("button", { name: "Отправить запрос", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Запрос будет отправлен в LO. Мост не сообщает состояние развёрнутости панели: успешный вызов не подтверждает изменение её высоты.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { phaseFixtureCalls: string[] }
        ).phaseFixtureCalls.includes("native:expand"),
      ),
    ).toBe(false);
    await page.screenshot({
      path: `test-results/expand-${width}-ready.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Отправить запрос", exact: true })
      .click();
    if (mode === "late")
      await page
        .getByRole("button", { name: "Остановить", exact: true })
        .click();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const report = JSON.parse(
            localStorage.getItem("sdk-test.last-run")!,
          ).report;
          return report.checks.find(
            (c: { id: string }) => c.id === "native:expand",
          )?.state;
        }),
      )
      .toBe(
        mode === "error" ? "failed" : mode === "late" ? "cancelled" : "manual",
      );
    const check = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("sdk-test.last-run")!).report.checks.find(
        (c: { id: string }) => c.id === "native:expand",
      ),
    );
    if (mode !== "success") {
      if (mode === "error")
        expect(check.detail).toContain("Expansion fixture refused");
      expect(check.evidence).not.toBe("device");
      return;
    }
    expect(check.detail).toContain("не сообщает состояние");
    expect(check.evidence).not.toBe("device");
    await expect(
      page.getByText("Панель мини-приложения стала выше?", { exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    const stop = page.getByRole("button", {
      name: "Остановить проверку",
      exact: true,
    });
    if (await stop.isVisible()) await stop.click();
    await page.getByRole("button", { name: "Все", exact: true }).click();
    await page.getByText("Развернуть панель", { exact: true }).click();
    await expect(page.getByText(check.detail, { exact: true })).toBeVisible();
    await page.screenshot({
      path: `test-results/expand-${width}-manual.png`,
      fullPage: true,
    });
  });
