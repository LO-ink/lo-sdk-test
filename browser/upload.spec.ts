import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error The production server is plain JavaScript without declarations.
import { createHandler } from "../server/app.mjs";

test("Chromium uploads a File with its byte length through the real handler", async ({
  page,
  request,
}) => {
  // Vite serves the actual application helper with its TypeScript erased.
  const helperResponse = await request.get("/web/api.ts");
  expect(helperResponse.ok()).toBe(true);
  const helper = await helperResponse.text();
  const uploadDirectory = await mkdtemp(join(tmpdir(), "lo-browser-upload-"));
  const bytes = Uint8Array.from(
    { length: 65536 + 123 },
    (_, index) => index % 256,
  );
  const now = Math.floor(Date.now() / 1000);
  const appKey = "synthetic-public-test-key";
  const params = {
    app_id: "test-app",
    auth_date: String(now),
    user: '{"id":42,"first_name":"Test"}',
  };
  const canonical = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(appKey).digest();
  const raw = new URLSearchParams({
    ...params,
    hash: createHmac("sha256", secret).update(canonical).digest("hex"),
  }).toString();
  let botCalls = 0;
  let incomingHeaders: Record<string, string | string[] | undefined> = {};
  let incomingMetadata: URLSearchParams | undefined;
  let handler: ReturnType<typeof createHandler>;
  const server = createServer((incoming, response) => {
    if (incoming.url === "/fixture") {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Upload wire fixture</title>");
      return;
    }
    if (incoming.url === "/api-helper.mjs") {
      response.setHeader("content-type", "text/javascript");
      response.end(helper);
      return;
    }
    if (incoming.url?.startsWith("/api/bot/upload?")) {
      incomingHeaders = { ...incoming.headers };
      incomingMetadata = new URL(incoming.url, "http://fixture.test")
        .searchParams;
    }
    void handler(incoming, response);
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing local port");
    const origin = `http://127.0.0.1:${address.port}`;
    handler = createHandler(
      {
        LO_APP_ID: "test-app",
        LO_APP_KEY: appKey,
        LO_BOT_TOKEN: "42:SYNTHETIC",
        LO_APP_URL: "https://app.example.test/",
        PUBLIC_ORIGIN: origin,
        LO_UPLOAD_DIR: uploadDirectory,
      },
      {
        now: () => now,
        fetch: async (url: string, options: RequestInit) => {
          expect(url).toBe("https://api.lo.ink/bot42:SYNTHETIC/sendDocument");
          botCalls++;
          expect(options.body).toBeInstanceOf(FormData);
          const form = options.body as FormData;
          expect(form.get("chat_id")).toBe("42");
          const file = form.get("document") as File;
          expect(file).toBeInstanceOf(Blob);
          expect(file.name).toBe("binary fixture.bin");
          expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
          return Response.json({
            ok: true,
            result: {
              message_id: 1,
              date: now,
              chat: { id: 42, type: "private" },
              document: { file_id: "browser-fixture" },
            },
          });
        },
      },
    );
    // Browser traffic is confined to the dynamically assigned fixture origin.
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    await page.goto(`${origin}/fixture`);
    const result = await page.evaluate(
      async ({ raw, values }) => {
        const modulePath = "/api-helper.mjs";
        const { api, uploadFile } = await import(/* @vite-ignore */ modulePath);
        await api("session", { raw });
        await api("consent", { allowed: true });
        const file = new File([new Uint8Array(values)], "binary fixture.bin", {
          type: "application/octet-stream",
        });
        return uploadFile("sendDocument", file);
      },
      { raw, values: Array.from(bytes) },
    );
    expect(result.result.fileId).toBe("browser-fixture");
    expect(botCalls).toBe(1);
    expect(incomingHeaders["content-length"]).toBe(String(bytes.length));
    expect(incomingHeaders["transfer-encoding"]).toBeUndefined();
    expect(incomingHeaders["content-type"]).toBe("application/octet-stream");
    expect(incomingHeaders["x-sdk-test"]).toBe("1");
    expect(incomingMetadata?.get("name")).toBe("binary fixture.bin");
    expect(incomingMetadata?.get("mime")).toBe("application/octet-stream");
    expect(await readdir(uploadDirectory)).toEqual([]);
  } finally {
    try {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    } finally {
      await rm(uploadDirectory, { recursive: true, force: true });
    }
  }
});
