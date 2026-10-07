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
    const manual = page.getByRole("tab", { name: "Вручную", exact: true });
    await manual.hover();
    expect(
      await manual.evaluate(
        (element) => element.getAttribute("aria-selected") === "false",
      ),
    ).toBe(true);
    expect(
      await manual.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).not.toBe("rgb(80, 96, 232)");
    await manual.click();
    await page.getByRole("tab", { name: "Бот", exact: true }).hover();
    expect(
      await page
        .getByRole("tab", { name: "Бот", exact: true })
        .evaluate(
          (element) => element.getAttribute("aria-selected") === "false",
        ),
    ).toBe(true);
    await page.getByRole("tab", { name: "UI", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "UI компоненты" }),
    ).toBeVisible();
    await expect(
      page.getByRole("tablist", { name: "Ручные проверки" }),
    ).toHaveCount(0);
    const host = await page.locator("html").evaluate((element) => ({
      theme: element.dataset.loTheme,
      background: getComputedStyle(element).backgroundColor,
    }));
    for (const theme of ["Светлая", "Тёмная", "Как в LO"]) {
      await page.getByRole("button", { name: theme, exact: true }).click();
      const expectedTheme =
        theme === "Как в LO" ? scheme : theme === "Тёмная" ? "dark" : "light";
      await expect(page.locator("html")).toHaveAttribute(
        "data-lo-theme",
        expectedTheme,
      );
      await page.emulateMedia({
        colorScheme: scheme === "light" ? "dark" : "light",
      });
      await expect(page.locator("html")).toHaveAttribute(
        "data-lo-theme",
        theme === "Как в LO"
          ? scheme === "light"
            ? "dark"
            : "light"
          : expectedTheme,
      );
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-lo-theme",
        expectedTheme,
      );
      const appearance = await page.evaluate(() => ({
        page: getComputedStyle(document.body).backgroundColor,
        header: getComputedStyle(document.querySelector("header h1")!).color,
        catalog: getComputedStyle(document.querySelector(".ui-catalog")!).color,
        nestedTheme: document
          .querySelector(".ui-catalog")!
          .hasAttribute("data-lo-theme"),
      }));
      expect(appearance.page).toBe(
        expectedTheme === "dark" ? "rgb(11, 14, 23)" : "rgb(247, 251, 255)",
      );
      expect(appearance.header).toBe(appearance.catalog);
      expect(appearance.nestedTheme).toBe(false);
      await page.getByRole("tab", { name: "Вручную", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute(
        "data-lo-theme",
        expectedTheme,
      );
      await page.getByRole("tab", { name: "UI", exact: true }).click();
      await expect(
        page.getByRole("button", { name: theme, exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      if (theme !== "Как в LO")
        await page.screenshot({
          path: `test-results/app-theme-${scheme}-${expectedTheme}.png`,
        });
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
      ).toEqual({ size: "14px", weight: "500", height: "44px" });
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
    await page.getByRole("tab", { name: "UI", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
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
    await page.getByRole("tab", { name: "UI", exact: true }).click();
    await page.getByRole("button", { name: "Открыть диалог" }).click();
    const dialog = page.getByRole("dialog", { name: "Пример диалога" });
    await expect(dialog).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Закрыть диалог" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Открыть диалог" }),
    ).toBeFocused();
    for (const section of await page.locator(".ui-demo").all()) {
      expect(
        await section.evaluate((e) => getComputedStyle(e).borderTopStyle),
      ).toBe("solid");
    }
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() => document.fonts.check('400 16px "LO Pro UI"')),
    ).toBe(true);
    expect(
      await page
        .getByRole("heading", { name: "UI компоненты" })
        .evaluate((e) => getComputedStyle(e).fontFamily),
    ).toContain("LO Pro UI");
    for (const image of await page
      .locator('.ui-demo[aria-label="AppIcon"] img')
      .all()) {
      expect(
        await image.evaluate((e) => (e as HTMLImageElement).naturalWidth),
      ).toBeGreaterThan(0);
    }
    expect(errors).toEqual([]);
  });
}

test("SDK appearance binding selects the published UI theme and canvas", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/node_modules/@lo-ink/miniapp-sdk/dist/index.js";
    const { bindAppearance, createMiniAppClient } = await import(
      /* @vite-ignore */ modulePath
    );
    const root = document.createElement("section");
    root.className = "lo-ui-root lo-ui-surface";
    document.body.append(root);
    const client = createMiniAppClient({
      id: "lo",
      launchData: "appearance-fixture",
      capabilities: new Set(),
      snapshot: () => ({ colorScheme: "dark" }),
      subscribe: () => () => {},
      execute: () => Promise.resolve(),
    });
    const bind = () =>
      bindAppearance(client, {
        root,
        prefersDark: () => false,
        background: (name: string) =>
          getComputedStyle(root).getPropertyValue(name),
        onPreferenceChange: () => () => {},
      });
    let release = bind();
    const dark = {
      theme: root.dataset.loTheme,
      canvas: getComputedStyle(root)
        .getPropertyValue("--lo-color-canvas")
        .trim(),
      text: getComputedStyle(root).color,
    };
    release();
    root.dataset.preference = "light";
    release = bind();
    const light = {
      theme: root.dataset.loTheme,
      canvas: getComputedStyle(root)
        .getPropertyValue("--lo-color-canvas")
        .trim(),
      text: getComputedStyle(root).color,
    };
    release();
    client.dispose();
    root.remove();
    return { dark, light };
  });
  expect(result).toEqual({
    dark: { theme: "dark", canvas: "#0b0e17", text: "rgb(247, 251, 255)" },
    light: { theme: "light", canvas: "#f7fbff", text: "rgb(18, 22, 36)" },
  });
});

test("manual filters retain whole labels, field geometry and text/action gaps", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.goto("/");
  await page.getByRole("tab", { name: "Вручную", exact: true }).click();
  for (const button of await page
    .locator("article .actions .lo-ui-button")
    .all()) {
    expect(
      await button.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        text: getComputedStyle(element).fontSize,
      })),
    ).toEqual({ height: 44, text: "14px" });
  }
  const row = page.getByRole("tablist", { name: "Группы проверок" });
  expect(await row.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  for (const tab of await row.getByRole("tab").all()) {
    expect(
      await tab.evaluate((e) => ({
        height: e.getBoundingClientRect().height,
        wrap: getComputedStyle(e).whiteSpace,
      })),
    ).toEqual({ height: 44, wrap: "nowrap" });
  }
  expect(
    await page
      .locator("#sdk-sections")
      .evaluate((e) => getComputedStyle(e).borderBottomWidth),
  ).toBe("0px");
  expect(
    await page.locator(".app").evaluate((e) => getComputedStyle(e).paddingLeft),
  ).toBe("10px");
  const search = page.getByRole("textbox", { name: "Найти проверку" });
  expect(
    await search.evaluate((e) => ({
      height: e.getBoundingClientRect().height,
      radius: getComputedStyle(e).borderRadius,
      fontSize: getComputedStyle(e).fontSize,
    })),
  ).toEqual({ height: 38, radius: "6px", fontSize: "16px" });
  await page.getByRole("tab", { name: "Данные запуска", exact: true }).click();
  const note = page.getByText("Сырая строка и ключи не входят в отчёт.");
  const button = page.getByRole("button", { name: "Проверить подпись" });
  const textBounds = await note.boundingBox(),
    buttonBounds = await button.boundingBox();
  expect(
    buttonBounds!.y - textBounds!.y - textBounds!.height,
  ).toBeGreaterThanOrEqual(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
});
test("touch swipes change main sections, preserve manual selection, and stop at boundaries", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.goto("/");
  const swipe = async (dx: number, dy = 0) =>
    page.locator("#sdk-panel").evaluate(
      (panel, { dx, dy }) => {
        const touch = (x: number, y: number) =>
          new Touch({ identifier: 1, target: panel, clientX: x, clientY: y });
        const initial = touch(200, 100),
          final = touch(200 + dx, 100 + dy);
        panel.dispatchEvent(
          new TouchEvent("touchstart", {
            bubbles: true,
            touches: [initial],
            changedTouches: [initial],
          }),
        );
        panel.dispatchEvent(
          new TouchEvent("touchmove", {
            bubbles: true,
            cancelable: true,
            touches: [final],
            changedTouches: [final],
          }),
        );
        panel.dispatchEvent(
          new TouchEvent("touchend", {
            bubbles: true,
            touches: [],
            changedTouches: [final],
          }),
        );
      },
      { dx, dy },
    );
  await swipe(-100);
  await expect(
    page.getByRole("tab", { name: "Вручную", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Журнал", exact: true }).click();
  await swipe(-100);
  await expect(
    page.getByRole("tab", { name: "UI", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await swipe(-100);
  await expect(
    page.getByRole("tab", { name: "UI", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await swipe(100);
  await expect(
    page.getByRole("tab", { name: "Журнал", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await swipe(100, 150);
  await expect(
    page.getByRole("tab", { name: "Вручную", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test.describe("native touch arbitration", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 320, height: 720 },
  });
  test("horizontal filters scroll while content swipes switch sections and vertical gestures scroll", async ({
    page,
  }) => {
    let releaseStatus!: () => void;
    const statusResponse = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    await page.route("**/api/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/api/status")
        await statusResponse;
      await route.fulfill({ status: 503, json: {} });
    });
    await page.goto("/");
    await page.getByRole("tab", { name: "Вручную", exact: true }).click();
    const session = await page.context().newCDPSession(page);
    const touch = async (x: number, y: number, dx: number, dy = 0) => {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      for (let step = 1; step <= 8; step++) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x + (dx * step) / 8, y: y + (dy * step) / 8 }],
        });
        await page.waitForTimeout(20);
      }
      await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    };
    const filters = page.getByRole("tablist", { name: "Группы проверок" });
    const row = (await filters.boundingBox())!;
    await touch(260, row.y + row.height / 2, -180);
    await expect
      .poll(() => filters.evaluate((e) => e.scrollLeft))
      .toBeGreaterThan(50);
    await expect(
      page.getByRole("tab", { name: "Вручную", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    // A late server result rerenders App with equivalent inline tab options.
    // It must not reclaim the scroll position chosen by the touch gesture.
    const response = page.waitForResponse("**/api/status");
    releaseStatus();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await filters.evaluate((element) => element.scrollLeft),
    ).toBeGreaterThan(50);
    const heading = (await page
      .locator("#sdk-panel .section-heading")
      .boundingBox())!;
    await touch(260, heading.y + 10, -160);
    await expect(
      page.getByRole("tab", { name: "UI", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await touch(20, 600, 0, -220);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(50);
    await expect(
      page.getByRole("tab", { name: "UI", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });
});
