import { expect, test } from "@playwright/test";

for (const mode of [
  "retain",
  "quota",
  "wrong-owner",
  "archive-loss",
  "retire",
] as const) {
  test(`historical report ${mode}: explicit export and durable preservation in actual App`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((mode) => {
      const id = "33333333-3333-4333-8333-333333333333";
      const snapshot = JSON.stringify({
        schema: 1,
        appVersion: "0.4.29",
        dependencies: "old-sdk@1",
        token: "private-extra",
        report: {
          id,
          owner: { appId: "fixture", userId: "42", auth: "private-owner" },
          startedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
          state: "finished",
          checks: Array.from({ length: 200 }, (_, i) => ({
            id: `${i % 2 ? "compat" : "native"}:${i}`,
            label: `Old check ${i}`,
            group: "Previous",
            state: i < 61 ? "passed" : "manual",
            detail: "Original detail",
            durationMs: 1,
            signature: "private-check",
          })),
          recovery: Object.fromEntries(
            ["native", "compat"].map((route) => [
              route,
              {
                key: `lo-sdk-run-${id}-${route}`,
                written: [],
                mutations: [],
                original: {},
              },
            ]),
          ),
        },
      });
      if (!localStorage.getItem("fixture.initialized")) {
        localStorage.setItem("sdk-test.last-run", snapshot);
        localStorage.setItem("fixture.initialized", "yes");
      }
      const original = localStorage.getItem("sdk-test.last-run");
      const calls: { operation: string; archived: boolean }[] = [];
      const listeners = new Set<(raw: string) => void>();
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("sdk-test.history.") && mode === "quota")
          throw new DOMException("fixture quota", "QuotaExceededError");
        set.call(this, key, value);
        if (key.startsWith("sdk-test.history.") && mode === "archive-loss")
          this.removeItem(key);
      };
      Object.assign(window, {
        historyFixture: { original, calls },
        LO: {
          MiniAppNative: {
            protocolVersion: 1,
            generation: "history-browser",
            launchData: new URLSearchParams({
              app_id: "fixture",
              user: JSON.stringify({
                id: mode === "wrong-owner" ? "other" : "42",
              }),
              auth_date: String(Math.floor(Date.now() / 1000)),
            }).toString(),
            operations: ["ready", "setBackgroundColor", "setBottomBarColor"],
            capabilities: ["ready", "backgroundColor", "bottomBarColor"],
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
                archived: Object.keys(localStorage).some((key) =>
                  key.startsWith("sdk-test.history."),
                ),
              });
              for (const listener of listeners)
                listener(
                  JSON.stringify({
                    channel: "lo.miniapp",
                    version: 1,
                    generation: "history-browser",
                    kind: "result",
                    id: message.id,
                    ok: true,
                    value: true,
                  }),
                );
            },
          },
        },
      });
    }, mode);
    await page.route("**/api/**", (route) =>
      route.fulfill({
        status: 200,
        json: route.request().url().endsWith("/verify-launch")
          ? { verified: true, appId: "fixture", userId: "42" }
          : route.request().url().endsWith("/status")
            ? { appConfigured: true, botConfigured: false }
            : {},
      }),
    );
    await page.goto("/");
    await expect(page.getByText("Сохранён прежний отчёт")).toBeVisible();
    if (mode === "retain") {
      for (const width of [320, 402]) {
        await page.setViewportSize({ width, height: 874 });
        const geometry = await page.evaluate(() => {
          const history = document.querySelector(
            '[aria-label="Прежний отчёт"]',
          )!;
          const launch = document.querySelector(
            '[aria-label="Запуск проверки"]',
          )!;
          return {
            gap:
              launch.getBoundingClientRect().top -
              history.getBoundingClientRect().bottom,
            token: Number.parseFloat(
              getComputedStyle(history).getPropertyValue("--lo-space-4"),
            ),
          };
        });
        expect(geometry.token).toBeGreaterThan(0);
        expect(geometry.gap).toBeCloseTo(geometry.token, 1);
      }
      await page.setViewportSize({ width: 320, height: 740 });
    }

    await expect(
      page.getByText("Срок продолжения истёк.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Продолжить проверку" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { historyFixture: { calls: unknown[] } })
            .historyFixture.calls,
      ),
    ).toEqual([]);
    await page.getByRole("button", { name: "Сохранить прежний отчёт" }).click();
    if (mode === "wrong-owner") {
      await expect(
        page.getByText(
          "Откройте прежний отчёт в том же приложении и аккаунте LO.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "JSON отчёта" }),
      ).toHaveCount(0);
    } else {
      const field = page.getByRole("textbox", { name: "JSON отчёта" });
      const raw = await field.inputValue();
      const exported = JSON.parse(raw);
      expect(exported.historical).toBe(true);
      expect(exported.currentEvidence).toBe(false);
      expect(exported.appVersion).toBe("0.4.29");
      expect(exported.appVersionMeaning).toBe(
        "last-serializer-version-not-execution-provenance",
      );
      expect(exported.executionAttribution.unknown).toBe(200);
      expect(exported.report.checks[0].execution).toEqual({
        build: null,
        unknown: "legacy",
      });
      expect(exported.report.checks).toHaveLength(200);
      expect(raw).not.toContain("private-");
      expect(raw).not.toContain("sdkBuild");
      await page.getByRole("button", { name: "Закрыть", exact: true }).click();
      await page
        .getByRole("button", { name: "Начать проверку", exact: true })
        .click();
      if (mode === "quota" || mode === "archive-loss") {
        await expect(
          page
            .getByText(
              mode === "quota"
                ? /Сохранение недоступно/
                : /Прежний отчёт или архив изменился/,
            )
            .first(),
        ).toBeVisible();
        const unchanged = await page.evaluate(() => {
          const f = (
            window as unknown as {
              historyFixture: { original: string; calls: unknown[] };
            }
          ).historyFixture;
          return {
            same: localStorage.getItem("sdk-test.last-run") === f.original,
            calls: f.calls,
          };
        });
        expect(unchanged).toEqual({ same: true, calls: [] });
      } else {
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                localStorage.getItem("sdk-test.last-run") !==
                (window as unknown as { historyFixture: { original: string } })
                  .historyFixture.original,
            ),
          )
          .toBe(true);
        const stop = page.getByRole("button", {
          name: "Остановить проверку",
          exact: true,
        });
        if (await stop.isVisible()) await stop.click();
        await expect(
          page.getByRole("button", { name: "Сохранить прежний отчёт" }),
        ).toBeVisible();
        expect(
          await page.evaluate(() =>
            (
              window as unknown as {
                historyFixture: { calls: { archived: boolean }[] };
              }
            ).historyFixture.calls.every((call) => call.archived),
          ),
        ).toBe(true);
        if (mode === "retire") {
          await page
            .getByRole("button", { name: "Освободить место в архиве" })
            .click();
          await expect(
            page.getByRole("textbox", { name: "JSON отчёта" }),
          ).toBeVisible();
          await page
            .getByRole("button", {
              name: "Копия сохранена — удалить из архива",
            })
            .click();
          await page
            .getByRole("button", { name: "Отмена", exact: true })
            .click();
          expect(
            await page.evaluate(
              () =>
                Object.keys(localStorage).filter((key) =>
                  key.startsWith("sdk-test.history."),
                ).length,
            ),
          ).toBe(1);
          await page
            .getByRole("button", { name: "Освободить место в архиве" })
            .click();
          await page
            .getByRole("button", {
              name: "Копия сохранена — удалить из архива",
            })
            .click();
          await page
            .getByRole("button", { name: "Продолжить", exact: true })
            .click();
          await expect(
            page.getByText(/Архивная копия удалена по вашему подтверждению/),
          ).toBeVisible();
          expect(
            await page.evaluate(
              () =>
                Object.keys(localStorage).filter((key) =>
                  key.startsWith("sdk-test.history."),
                ).length,
            ),
          ).toBe(0);
        } else {
          await page.reload();
          await expect(page.getByText("Прежний отчёт в архиве")).toBeVisible();
          await expect(
            page.getByText("Новый запуск сохранит её в локальном архиве.", {
              exact: false,
            }),
          ).toHaveCount(0);
          await page
            .getByRole("button", { name: "Сохранить прежний отчёт" })
            .click();
          expect(
            JSON.parse(
              await page
                .getByRole("textbox", { name: "JSON отчёта" })
                .inputValue(),
            ).appVersion,
          ).toBe("0.4.29");
        }
      }
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("fresh launch keeps its original position without a historical report", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Начать проверку", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Прежний отчёт", exact: true }),
  ).toHaveCount(0);
  for (const width of [320, 402]) {
    await page.setViewportSize({ width, height: 874 });
    const offset = await page.evaluate(() => {
      const panel = document.querySelector("#sdk-panel")!;
      const launch = document.querySelector('[aria-label="Запуск проверки"]')!;
      return (
        launch.getBoundingClientRect().top - panel.getBoundingClientRect().top
      );
    });
    expect(offset).toBeCloseTo(0, 1);
  }
});
