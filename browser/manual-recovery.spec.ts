import { expect, test } from "@playwright/test";
import build from "../sdk-build.json" with { type: "json" };

for (const owner of ["known", "unknown"] as const) {
  test(`manual ${owner}-owner cleanup exports its full ticket and archives unverified attestation before a fresh run`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.addInitScript((identity) => {
      const id = "33333333-3333-4333-8333-333333333333";
      const route = identity === "known" ? "compat" : "native";
      const original = JSON.stringify({
        schema: 1,
        appVersion: "old",
        dependencies: "old",
        report: {
          id,
          ...(identity === "known"
            ? { owner: { appId: "old-app", userId: "old-user" } }
            : {}),
          startedAt: new Date(Date.now() - 60000).toISOString(),
          state: "cancelled",
          checks: [
            {
              id: "cleanup",
              label: "cleanup",
              group: "fixture",
              state: "failed",
              detail: "Interrupted",
              durationMs: 1,
            },
          ],
          recovery: {
            [route]: {
              key: `lo-sdk-run-${id}-${route}`,
              written: ["deviceStorage"],
              mutations: ["setButton", "setBackgroundColor"],
              buttons: ["main"],
              original: { theme: { background: "#123456" } },
            },
          },
        },
      });
      if (!localStorage.getItem("fixture.initialized")) {
        localStorage.setItem("sdk-test.last-run", original);
        localStorage.setItem("fixture.initialized", "true");
      }
      Object.assign(window, { manualFixture: { original, id } });
    }, owner);
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 503, json: { error: "fixture unavailable" } }),
    );
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Начать проверку" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Показать данные очистки" }).click();
    const json = JSON.parse(
      await page
        .getByRole("textbox", { name: "Полная запись очистки (JSON)" })
        .inputValue(),
    );
    expect(json.owner).toEqual(
      owner === "known" ? { appId: "old-app", userId: "old-user" } : null,
    );
    expect(
      json.obligations[owner === "known" ? "compat" : "native"].original.theme
        .background,
    ).toBe("#123456");
    const confirm = page.getByRole("button", {
      name: "Сохранить подтверждение ручной очистки",
    });
    await expect(confirm).toBeDisabled();
    await page.getByRole("checkbox", { name: /Я удалил все/ }).check();
    await expect(confirm).toBeEnabled();
    await page.getByRole("checkbox", { name: /Я удалил все/ }).uncheck();
    await expect(confirm).toBeDisabled();
    await page.getByRole("checkbox", { name: /Я удалил все/ }).check();
    await confirm.click();
    await expect(
      page.getByText(/Ручная очистка подтверждена вами, SDK её не проверял/),
    ).toBeVisible();
    const archived = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) =>
        name.startsWith("sdk-test.manual-cleanup."),
      )!;
      return {
        archive: JSON.parse(localStorage.getItem(key)!),
        current: localStorage.getItem("sdk-test.last-run"),
      };
    });
    expect(archived.archive.verified).toBe(false);
    expect(archived.archive.snapshot).toBe(archived.current);
    expect(JSON.parse(archived.archive.snapshot).report.checks[0].state).toBe(
      "failed",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    await expect(page.getByText("Завершите восстановление")).toHaveCount(0);
    const replacement = JSON.stringify({
      schema: 1,
      appVersion: build.appVersion,
      dependencies: build.packages
        .map((item) => `${item.name}@${item.version}`)
        .sort()
        .join("|"),
      report: {
        id: "66666666-6666-4666-8666-666666666666",
        owner: { appId: "another-app", userId: "another-user" },
        startedAt: new Date(Date.now() - 60000).toISOString(),
        state: "cancelled",
        checks: [
          {
            id: "cleanup",
            label: "Cleanup",
            group: "fixture",
            state: "failed",
            detail: "Current-build debt",
            durationMs: 1,
          },
        ],
        recovery: {
          native: {
            key: "lo-sdk-run-66666666-6666-4666-8666-666666666666-native",
            written: ["deviceStorage"],
            mutations: [],
            original: {},
          },
        },
      },
    });
    await page.evaluate(
      (raw) => localStorage.setItem("sdk-test.last-run", raw),
      replacement,
    );
    await page.getByRole("button", { name: "Начать проверку" }).click();
    await expect(
      page.getByText(/Архив или сохранённый прогон изменился/),
    ).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("sdk-test.last-run")),
    ).toBe(replacement);
    await page.evaluate(
      (raw) => localStorage.setItem("sdk-test.last-run", raw!),
      archived.current,
    );
    await page.getByRole("button", { name: "Начать проверку" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("sdk-test.last-run")!).report.id,
        ),
      )
      .not.toBe("33333333-3333-4333-8333-333333333333");
    expect(
      await page.evaluate(
        () =>
          Object.keys(localStorage).filter((name) =>
            name.startsWith("sdk-test.manual-cleanup."),
          ).length,
      ),
    ).toBe(1);
  });
}
