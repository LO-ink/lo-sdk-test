import { expect, test } from "@playwright/test";
import build from "../sdk-build.json" with { type: "json" };

for (const width of [320, 402]) {
  test(`source comparison copy stays readable at ${width}px while loading and after a dated result`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 874 });
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/sdk-versions", async (route) => {
      await pending;
      await route.fulfill({
        json: {
          basis: "github-main",
          checkedAt: "2026-10-08T12:34:00Z",
          packages: build.packages.map((p, i) => ({
            ...p,
            state: i % 2 ? "update" : "current",
          })),
        },
      });
    });
    const panel = page.locator(".sdk-versions");
    const assertGeometry = async () => {
      expect(
        await panel.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            [...element.querySelectorAll("li")].every((row) => {
              const name = row.querySelector(".sdk-package")!;
              const status = row.querySelector(".version-status")!;
              const left = name.getBoundingClientRect(),
                right = status.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(name);
              return (
                left.left >= bounds.left &&
                right.right <= bounds.right + 1 &&
                right.left - left.right >= 11 &&
                [...range.getClientRects()].every(
                  (rect) => rect.right <= left.right + 1,
                )
              );
            }) &&
            element.scrollWidth <= element.clientWidth + 1 &&
            document.documentElement.scrollWidth <= innerWidth
          );
        }),
      ).toBe(true);
    };
    try {
      await page.goto("/");
      await expect(
        panel.getByText("Сравниваем исходники…", { exact: true }),
      ).toHaveCount(5);
      await page.evaluate(() => document.fonts.ready);
      await assertGeometry();
      release();
      await expect(
        panel.getByText("Совпадает с main", { exact: true }),
      ).toHaveCount(2);
      await expect(
        panel.getByText("Изменения в main", { exact: true }),
      ).toHaveCount(2);
      await expect(panel.getByRole("status")).toContainText(
        "Сравнение исходников с main на GitHub ·",
      );
      await assertGeometry();
      await test.info().attach("source-comparison", {
        body: await panel.screenshot(),
        contentType: "image/png",
      });
    } finally {
      release();
    }
  });
}
