import assert from "node:assert/strict";
import { request } from "node:http";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
const mode = process.argv[2];
const size = 50 * 1024 * 1024;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (mode === "server") {
  const { createHandler } = await import("/app/server/app.mjs");
  const config = {
    LO_APP_ID: "test-app",
    LO_APP_KEY: "synthetic-public-test-key",
    LO_BOT_TOKEN: "42:SYNTHETIC",
    LO_APP_URL: "https://app.example.test/",
    LO_UPLOAD_DIR: "/var/lib/lo-sdk-test/uploads",
  };
  const handler = createHandler(config, {
    fetch: (url, options) => {
      if (!url.startsWith("https://api.lo.ink/bot42:SYNTHETIC/"))
        throw new Error("Unexpected outbound URL");
      return fetch("http://127.0.0.1:5501" + new URL(url).pathname, options);
    },
  });
  let maximumRss = 0,
    maximumAnon = 0,
    maximumFile = 0,
    checks = 0,
    healthFailures = 0,
    health;
  const metrics = () => ({
    node: process.version,
    memory: process.memoryUsage(),
    maximumRss,
    maximumAnon,
    maximumFile,
    healthFailures,
    current: Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8")),
    peak: Number(readFileSync("/sys/fs/cgroup/memory.peak", "utf8")),
    events: readFileSync("/sys/fs/cgroup/memory.events", "utf8"),
    stat: Object.fromEntries(
      readFileSync("/sys/fs/cgroup/memory.stat", "utf8")
        .trim()
        .split("\n")
        .map((x) => x.split(" "))
        .filter(([key]) => ["anon", "file", "shmem"].includes(key)),
    ),
    checks,
  });
  const sampling = setInterval(() => {
    maximumRss = Math.max(maximumRss, process.memoryUsage().rss);
    const sample = metrics();
    maximumAnon = Math.max(maximumAnon, Number(sample.stat.anon));
    maximumFile = Math.max(maximumFile, Number(sample.stat.file));
  }, 25);
  const healthInterval = setInterval(() => {
    if (health) return;
    health = spawn(
      process.execPath,
      [
        "-e",
        "fetch('http://127.0.0.1:5407/api/status',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1))",
      ],
      { stdio: "ignore" },
    );
    health.on("exit", (code) => {
      if (code === 0) checks++;
      else healthFailures++;
      health = undefined;
    });
  }, 1000);
  const server = createServer(async (req, res) => {
    if (req.url === "/__probe/metrics") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ...metrics(),
          files: await readdir(config.LO_UPLOAD_DIR).catch(() => []),
        }),
      );
      return;
    }
    if (req.url === "/__probe/finish") {
      clearInterval(sampling);
      clearInterval(healthInterval);
      if (health) await once(health, "exit");
      console.log(JSON.stringify(metrics()));
      res.end("finished");
      server.close();
      return;
    }
    return handler(req, res);
  });
  server.requestTimeout = 60000;
  server.listen(5407, "127.0.0.1", () => console.log("ready"));
}

if (mode === "client") {
  const base = "http://127.0.0.1:5407";
  const boundedFetch = (url, options = {}) =>
    fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const json = async (path, value, cookie = "") =>
    boundedFetch(base + path, {
      method: "POST",
      headers: {
        "x-sdk-test": "1",
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify(value),
    });
  for (let n = 0; ; n++) {
    try {
      const status = await boundedFetch(base + "/api/status");
      if (status.ok) break;
    } catch {}
    if (n > 60) throw new Error("server notready");
    await wait(500);
  }
  const release = await (await boundedFetch(base + "/release.json")).json();
  assert.equal(release.revision, process.env.BUILD_REVISION);
  async function createSession(id) {
    const params = {
      app_id: "test-app",
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id, first_name: "Test" }),
    };
    const canonical = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const key = createHmac("sha256", "WebAppData")
      .update("synthetic-public-test-key")
      .digest();
    const raw = new URLSearchParams({
      ...params,
      hash: createHmac("sha256", key).update(canonical).digest("hex"),
    }).toString();
    const session = await json("/api/session", { raw });
    assert.equal(session.status, 200);
    return session.headers.get("set-cookie").split(";")[0];
  }
  const cookie = await createSession(42);
  assert.equal(
    (await json("/api/consent", { allowed: true }, cookie)).status,
    200,
  );
  const report = Buffer.from(
    JSON.stringify({ report: { log: "x".repeat(500000) } }),
  );
  // Keep the report store near its aggregate limit throughout uploads.
  let controlCookie;
  for (let id = 43; id <= 50; id++) {
    const otherCookie = await createSession(id);
    if (id === 43) controlCookie = otherCookie;
    const response = await json(
      "/api/report",
      { report: { log: "x".repeat(500000) } },
      otherCookie,
    );
    assert.equal(response.status, 200);
  }
  assert.equal(
    (
      await json(
        "/api/report",
        { report: { log: "x".repeat(500000) } },
        await createSession(51),
      )
    ).status,
    429,
  );
  // Reuse one retained owner so each control request replaces an existing report.
  function pending(path, contentType, length) {
    let resolve, reject;
    const response = new Promise((r, j) => {
      resolve = r;
      reject = j;
    });
    const req = request(
      base + path,
      {
        method: "POST",
        headers: {
          "x-sdk-test": "1",
          "content-type": contentType,
          "content-length": String(length),
          cookie: path === "/api/report" ? controlCookie : cookie,
          connection: "close",
        },
      },
      (res) => {
        let text = "";
        res.on("data", (part) => (text += part));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.setTimeout(30000, () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
    req.flushHeaders();
    return { req, response };
  }
  let rejected = 0;
  for (let run = 0; run < 5; run++) {
    const started = Date.now();
    const upload = pending(
      "/api/bot/upload?operation=sendDocument&name=fixture.bin&mime=application%2Foctet-stream",
      "application/octet-stream",
      size,
    );
    const chunk = Buffer.alloc(64 * 1024, 1);
    upload.req.write(chunk);
    await wait(50);
    // Exercise the upload lock before the global POST limit is occupied.
    const competing = pending(
      "/api/bot/upload?operation=sendDocument&name=competing.bin",
      "application/octet-stream",
      size,
    );
    const refusal = await competing.response;
    assert.equal(refusal.status, 429, refusal.text);
    competing.req.destroy();
    rejected++;
    const controls = Array.from({ length: 7 }, () => {
      const control = pending("/api/report", "application/json", report.length);
      control.req.write(report.subarray(0, -1));
      return control;
    });
    await wait(150);
    const refusals = Array.from({ length: 8 }, () =>
      pending(
        "/api/bot/upload?operation=sendDocument&name=other.bin",
        "application/octet-stream",
        size,
      ),
    );
    for (const refusal of refusals) {
      const result = await refusal.response;
      assert.equal(result.status, 429, result.text);
      rejected++;
      refusal.req.destroy();
    }
    for (let bytes = chunk.length; bytes < size; bytes += chunk.length) {
      if (!upload.req.write(chunk)) await once(upload.req, "drain");
    }
    upload.req.end();
    const result = await upload.response;
    assert.equal(result.status, 200, result.text);
    assert.equal(JSON.parse(result.text).result.fileId, "fixture");
    for (const control of controls) control.req.end(report.subarray(-1));
    for (const control of controls) {
      const result = await control.response;
      assert.equal(result.status, 200, result.text);
    }
    const metrics = await (
      await boundedFetch(base + "/__probe/metrics")
    ).json();
    assert.deepEqual(metrics.files, []);
    assert.equal(metrics.healthFailures, 0);
    assert.match(metrics.events, /oom 0\n/);
    assert.match(metrics.events, /oom_kill 0\n/);
    console.log(JSON.stringify({ run: run + 1, rejected, ...metrics }));
    await wait(Math.max(0, 2100 - (Date.now() - started)));
  }
  assert.equal(
    (
      await json(
        "/api/report",
        { report: { log: "x".repeat(512 * 1024) } },
        cookie,
      )
    ).status,
    413,
  );
  assert.equal((await boundedFetch(base + "/api/status")).status, 200);
  const final = await (await boundedFetch(base + "/__probe/metrics")).json();
  assert.ok(final.checks > 0);
  assert.equal(final.healthFailures, 0);
  await boundedFetch(base + "/__probe/finish");
  console.log(
    JSON.stringify({
      uploads: 5,
      bytesPerUpload: size,
      rejected,
      controls: 35,
      result: "passed",
    }),
  );
}
if (mode === "sink") {
  createServer(async (req, res) => {
    if (req.url === "/health") {
      res.end("ok");
      return;
    }
    let count = 0;
    for await (const chunk of req) count += chunk.length;
    if (count < size) {
      res.statusCode = 400;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        result: {
          message_id: 1,
          date: 1,
          chat: { id: 42, type: "private" },
          document: { file_id: "fixture" },
        },
      }),
    );
  }).listen(5501, "127.0.0.1");
}
