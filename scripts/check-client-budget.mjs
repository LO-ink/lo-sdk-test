import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium, expect } from "@playwright/test";

const root = realpathSync(
  process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url)),
);
// Reviewed cold-start budgets; changes require a new measured baseline.
const limits = {
  js: { bytes: 480 * 1024, gzip: 140 * 1024 },
  css: { bytes: 39 * 1024, gzip: 7.5 * 1024 },
  woff2: { bytes: 600 * 1024, count: 4 },
};
function localFile(pathname) {
  const file = realpathSync(resolve(root, `.${pathname}`));
  assert.ok(file.startsWith(root + sep), "Asset escaped the build directory");
  return file;
}
const errors = [];
const assets = new Map();
const contentTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = createServer((request, response) => {
  try {
    assert.equal(request.method, "GET");
    const pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    const file = localFile(pathname === "/" ? "/index.html" : pathname);
    const bytes = readFileSync(file);
    const extension = extname(file);
    if ([".js", ".css", ".woff2"].includes(extension))
      assets.set(file, {
        path: file.slice(root.length),
        type: extension.slice(1),
        bytes: bytes.length,
        ...(extension !== ".woff2"
          ? { gzip: gzipSync(bytes, { level: 9 }).length }
          : {}),
      });
    response.writeHead(200, {
      "content-type": contentTypes[extension] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(bytes);
  } catch {
    errors.push(`Missing or invalid local asset: ${request.url}`);
    response.writeHead(404).end();
  }
});
let browser;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 320, height: 720 },
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      errors.push(`External request: ${url.origin}`);
      return route.abort();
    }
    if (url.pathname.startsWith("/api/"))
      return route.fulfill({ status: 503, json: {} });
    return route.continue();
  });
  await context.routeWebSocket("**/*", (route) => {
    errors.push("Unexpected WebSocket connection");
    route.close();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) =>
    errors.push(`Failed request: ${request.url()}`),
  );
  await page.goto(origin, { waitUntil: "networkidle" });
  assert.deepEqual(errors, []);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "UI", exact: true }),
  ).toBeVisible();
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((font) => font.status !== "unloaded")
      .map((font) => ({
        status: font.status,
        family: font.family,
        weight: font.weight,
        style: font.style,
      }));
  });
  assert.ok(
    fonts.every((font) => font.status === "loaded"),
    "Font failed to load",
  );
  assert.ok(
    fonts.some(
      (font) => font.family === '"LO Pro UI"' || font.family === "LO Pro UI",
    ),
    "LO UI font was not loaded",
  );
  const session = await context.newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root: documentNode } = await session.send("DOM.getDocument");
  const renderedFonts = [];
  for (const selector of ["h1", '[role="tab"]', "header .connection", "code"]) {
    const { nodeId } = await session.send("DOM.querySelector", {
      nodeId: documentNode.nodeId,
      selector,
    });
    assert.ok(nodeId, `Missing font probe: ${selector}`);
    const result = await session.send("CSS.getPlatformFontsForNode", {
      nodeId,
    });
    assert.ok(
      result.fonts.length > 0 &&
        result.fonts.every((font) => font.isCustomFont && font.glyphCount > 0),
      `Fallback font rendered: ${selector}`,
    );
    renderedFonts.push({ selector, fonts: result.fonts });
  }
  assert.deepEqual(errors, []);
  const summary = Object.fromEntries(
    ["js", "css", "woff2"].map((type) => {
      const files = [...assets.values()].filter((file) => file.type === type);
      assert.ok(files.length > 0, `No initial ${type} assets`);
      return [
        type,
        {
          count: files.length,
          bytes: files.reduce((sum, file) => sum + file.bytes, 0),
          ...(type !== "woff2"
            ? { gzip: files.reduce((sum, file) => sum + file.gzip, 0) }
            : {}),
        },
      ];
    }),
  );
  const shippedFonts = readdirSync(resolve(root, "assets")).filter((name) =>
    name.endsWith(".woff2"),
  );
  console.log(
    JSON.stringify(
      {
        limits,
        initial: summary,
        shippedFonts: {
          count: shippedFonts.length,
          bytes: shippedFonts.reduce(
            (sum, name) =>
              sum + readFileSync(localFile(`/assets/${name}`)).length,
            0,
          ),
        },
        fonts,
        renderedFonts,
        assets: [...assets.values()],
      },
      null,
      2,
    ),
  );
  for (const [type, budget] of Object.entries(limits))
    for (const [metric, maximum] of Object.entries(budget))
      assert.ok(
        summary[type][metric] <= maximum,
        `Initial ${type} ${metric}: ${summary[type][metric]} exceeds ${maximum}`,
      );
} finally {
  try {
    await browser?.close();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
