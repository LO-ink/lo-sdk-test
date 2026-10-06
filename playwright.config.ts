import { defineConfig } from "@playwright/test";

const port = process.env.UI_BROWSER_PORT ?? "4186";
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./browser",
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
