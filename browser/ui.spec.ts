import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: navigation and gallery retain library styles at 320px`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 720 });
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    const manual = page.getByRole("button", { name: "Вручную", exact: true });
    await manual.hover();
    expect(
      await manual.evaluate((element) =>
        element.classList.contains("lo-ui-button--quiet"),
      ),
    ).toBe(true);
    expect(
      await manual.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).not.toBe("rgb(80, 96, 232)");
    await manual.click();
    await page.getByRole("button", { name: "Бот", exact: true }).hover();
    expect(
      await page
        .getByRole("button", { name: "Бот", exact: true })
        .evaluate((element) =>
          element.classList.contains("lo-ui-button--secondary"),
        ),
    ).toBe(true);
    await page.getByRole("button", { name: "UI", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "UI компоненты" }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Ручные проверки" }),
    ).toHaveCount(0);
    const host = await page.locator("html").evaluate((element) => ({
      theme: element.dataset.loTheme,
      background: getComputedStyle(element).backgroundColor,
    }));
    for (const theme of ["Светлая", "Тёмная", "Как в LO"]) {
      await page.getByRole("button", { name: theme, exact: true }).click();
      const compact = page.getByRole("button", {
        name: "Маленькая",
        exact: true,
      });
      expect(
        await compact.evaluate((element) => ({
          size: getComputedStyle(element).fontSize,
          weight: getComputedStyle(element).fontWeight,
          height: getComputedStyle(element).minHeight,
        })),
      ).toEqual({ size: "14px", weight: "600", height: "44px" });
      const text = page.getByText("Основной · body", { exact: true });
      const catalog = page.locator(".ui-catalog");
      expect(
        await text.evaluate((element) => getComputedStyle(element).color),
      ).toBe(
        await catalog.evaluate((element) => getComputedStyle(element).color),
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(320);
      for (const group of [
        page.getByRole("button"),
        page.getByRole("textbox"),
        page.getByRole("checkbox"),
        page.getByRole("switch"),
        page.getByRole("listitem"),
      ]) {
        for (const control of await group.all()) {
          const bounds = await control.boundingBox();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
        }
      }
    }
    expect(
      await page.locator("html").evaluate((element) => ({
        theme: element.dataset.loTheme,
        background: getComputedStyle(element).backgroundColor,
      })),
    ).toEqual(host);
    await page.getByRole("button", { name: "primary", exact: true }).click();
    await expect(page.getByText("Нажатий: 1")).toBeVisible();
    const field = page.getByRole("textbox", { name: "Название", exact: true });
    await field.fill("x");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAccessibleDescription(
      "Минимум три символа Слишком короткое название",
    );
    const toggle = page.getByRole("checkbox", {
      name: "Закрытый список",
      exact: true,
    });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await page.getByRole("button", { name: "Создать пример" }).click();
    await expect(
      page.getByText("Пример создан", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Проверка", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(manual).toBeFocused();
    const focus = await manual.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        style: style.outlineStyle,
        offset: style.outlineOffset,
        width: style.outlineWidth,
      };
    });
    expect(focus).toEqual({ style: "solid", offset: "-3px", width: "3px" });
    expect(errors).toEqual([]);
  });
}
