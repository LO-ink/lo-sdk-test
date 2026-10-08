import { expect, test } from "@playwright/test";

for (const failure of [
  "startup",
  "host-effect",
  "remove",
  "before-mutation",
  "after-mutation",
] as const) {
  test(`real App survives ${failure} storage denial without losing cleanup obligations`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((mode) => {
      const durable = window.localStorage;
      const originalSet = durable.setItem.bind(durable);
      const calls: string[] = [];
      const listeners = new Set<(raw: string) => void>();
      let reads = 0,
        denied = false;
      Object.assign(window, { storageFixture: { calls, durable } });
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          reads++;
          if (mode === "startup" || (mode === "host-effect" && reads >= 4))
            throw new DOMException("private origin", "SecurityError");
          return durable;
        },
      });
      if (mode === "remove") {
        Storage.prototype.removeItem = function () {
          throw new DOMException("private storage", "SecurityError");
        };
        Object.defineProperty(window, "AudioContext", {
          configurable: true,
          value: function () {
            calls.push("audio-context");
            throw new Error("Must not initialize audio after denied storage");
          },
        });
      }
      Storage.prototype.setItem = function (key, value) {
        if (this === durable && key === "sdk-test.last-run") {
          const saved = JSON.parse(value);
          if (
            mode === "before-mutation" &&
            saved.report.recovery?.native?.written?.length
          )
            denied = true;
          if (denied)
            throw new DOMException("private quota", "QuotaExceededError");
        }
        originalSet(key, value);
      };
      Object.assign(window, {
        LO: {
          MiniAppNative: {
            protocolVersion: 1,
            generation: "storage-fixture",
            launchData: new URLSearchParams({
              app_id: "fixture",
              user: JSON.stringify({ id: "42" }),
              auth_date: String(Math.floor(Date.now() / 1000)),
            }).toString(),
            operations: [
              "ready",
              "deviceStorageSet",
              "deviceStorageGet",
              "deviceStorageRemove",
            ],
            capabilities: ["ready", "deviceStorage"],
            snapshot: () => ({ colorScheme: "light" }),
            subscribe: (listener: (raw: string) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            postMessage: (raw: string) => {
              const message = JSON.parse(raw);
              if (message.kind !== "request") return;
              calls.push(message.operation);
              if (
                mode === "after-mutation" &&
                message.operation === "deviceStorageSet"
              )
                denied = true;
              for (const listener of listeners)
                listener(
                  JSON.stringify({
                    channel: "lo.miniapp",
                    version: 1,
                    generation: "storage-fixture",
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
    }, failure);
    await page.route("**/api/**", (route) =>
      route.fulfill({
        status: 200,
        json: route.request().url().endsWith("/status")
          ? { appConfigured: true, botConfigured: false }
          : route.request().url().endsWith("/session")
            ? { verified: true, appId: "fixture", userId: "42" }
            : {},
      }),
    );
    await page.goto("/");
    if (failure === "remove") {
      await expect(
        page.getByText("LO подключён", { exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        (
          window as unknown as { storageFixture: { calls: string[] } }
        ).storageFixture.calls.length = 0;
      });
    }
    if (
      failure === "remove" ||
      failure === "before-mutation" ||
      failure === "after-mutation"
    )
      await page
        .getByRole("button", { name: "Начать проверку", exact: true })
        .click();
    await expect(
      page.getByRole("region", { name: "Сохранение недоступно" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole("button", { name: "Начать проверку", exact: true }),
    ).toHaveCount(0);
    if (failure === "remove") {
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { storageFixture: { calls: string[] } })
              .storageFixture.calls,
        ),
      ).toEqual([]);
    }
    if (failure === "before-mutation" || failure === "after-mutation") {
      const saved = await page.evaluate(() => {
        const fixture = (
          window as unknown as {
            storageFixture: { calls: string[]; durable: Storage };
          }
        ).storageFixture;
        return {
          calls: fixture.calls,
          report: JSON.parse(fixture.durable.getItem("sdk-test.last-run")!)
            .report,
        };
      });
      expect(saved.calls.includes("deviceStorageSet")).toBe(
        failure === "after-mutation",
      );
      expect(
        saved.report.checks.find(
          (check: { id: string }) => check.id === "cleanup",
        ).state,
      ).not.toBe("passed");
      if (failure === "after-mutation")
        expect(saved.report.recovery.native.written).toContain("deviceStorage");
      expect(saved.calls).not.toContain("deviceStorageRemove");
    }
    await page.getByRole("tab", { name: "Вручную", exact: true }).click();
    await page
      .getByRole("tab", { name: "Данные запуска", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Проверить подпись", exact: true })
      .click();
    await expect(page.getByText("Проверена", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "UI", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "UI компоненты" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}
