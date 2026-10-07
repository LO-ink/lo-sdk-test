import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { createHandler } from "../server/app.mjs";

const appKey = "synthetic-report-test-key";
const start = 1800000000;

async function fixture(t) {
  let now = start;
  const server = createServer(
    createHandler(
      { LO_APP_ID: "report-test", LO_APP_KEY: appKey },
      { now: () => now, fetch: () => assert.fail("No network expected") },
    ),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, cookie = "", method) =>
    fetch(origin + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        "x-sdk-test": "1",
        cookie,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  return {
    request,
    expire: () => {
      now += 60;
    },
    async login(user = "1") {
      const params = {
        app_id: "report-test",
        auth_date: String(now),
        user: JSON.stringify({ id: user, first_name: "Test" }),
      };
      const joined = Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
      const secret = createHmac("sha256", "WebAppData").update(appKey).digest();
      const raw = new URLSearchParams({
        ...params,
        hash: createHmac("sha256", secret).update(joined).digest("hex"),
      }).toString();
      const response = await request("/api/session", { raw });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    },
  };
}

test("report handler stores compact nested redacted JSON and preserves download behavior", async (t) => {
  const { request, login, expire } = await fixture(t);
  const cookie = await login();
  const report = {
    results: {
      nested: [
        { status: "pass", token: "synthetic-private", queryId: "private" },
      ],
    },
    sdkBuild: { packages: [] },
    ignored: "omitted",
  };
  const response = await request("/api/report", { report }, cookie);
  assert.equal(response.status, 200);
  const { path } = await response.json();
  const download = await request(path);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  const text = await download.text();
  assert.equal(
    text,
    JSON.stringify({
      results: {
        nested: [{ status: "pass", token: "[скрыто]", queryId: "[скрыто]" }],
      },
      sdkBuild: { packages: [] },
    }),
  );
  assert.equal((await request(path, undefined, "", "HEAD")).status, 200);
  const replacement = await request(
    "/api/report",
    { report: { results: "new" } },
    cookie,
  );
  assert.equal(replacement.status, 200);
  assert.equal((await request(path)).status, 404);
  const next = (await replacement.json()).path;
  expire();
  assert.equal((await request(next)).status, 404);
});

test("deep and wide requests are refused before serialization and preserve the previous report", async (t) => {
  const { request, login } = await fixture(t);
  const cookie = await login();
  const { path } = await (
    await request("/api/report", { report: { results: "previous" } }, cookie)
  ).json();
  const valid = `{"report":{"results":${"[".repeat(31)}0${"]".repeat(31)}}}`;
  assert.equal(
    (await request("/api/report", valid, await login("2"))).status,
    200,
  );
  for (const body of [
    `{"report":{"results":${"[".repeat(32)}0${"]".repeat(32)}}}`,
    `{"report":{"results":${"[".repeat(20_000)}0${"]".repeat(20_000)}}}`,
    JSON.stringify({ report: { results: Array(50_000).fill(null) } }),
  ]) {
    assert.ok(Buffer.byteLength(body) < 512 << 10);
    const response = await request("/api/report", body, cookie);
    assert.equal(response.status, 413);
    assert.equal(typeof (await response.json()).message, "string");
    assert.equal((await request(path)).status, 200);
  }
});

test("redaction growth is subject to the serialized UTF-8 byte cap", async (t) => {
  const { request, login } = await fixture(t);
  const cookie = await login();
  const { path } = await (
    await request("/api/report", { report: { results: "previous" } }, cookie)
  ).json();
  const results = Object.fromEntries(
    Array.from({ length: 26_000 }, (_, index) => [`token${index}`, ""]),
  );
  const body = JSON.stringify({ report: { results } });
  assert.ok(Buffer.byteLength(body) < 512 << 10);
  assert.equal((await request("/api/report", body, cookie)).status, 413);
  assert.equal((await request(path)).status, 200);
});

test("global UTF-8 retention budget rejects replacement atomically and expiry frees it", async (t) => {
  const { request, login, expire } = await fixture(t);
  const cookie = await login();
  const { path } = await (
    await request("/api/report", { report: { results: "previous" } }, cookie)
  ).json();
  const large = { report: { log: "é".repeat(240_000) } };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 512 << 10);
  for (let user = 2; user <= 9; user++)
    assert.equal(
      (await request("/api/report", large, await login(String(user)))).status,
      200,
    );
  assert.equal((await request("/api/report", large, cookie)).status, 429);
  const previous = await request(path);
  assert.equal(previous.status, 200);
  assert.equal((await previous.json()).results, "previous");
  expire();
  assert.equal((await request("/api/report", large, cookie)).status, 200);
  assert.equal((await request(path)).status, 404);
});

test("report count remains capped at 32 while a session can replace its own file", async (t) => {
  const { request, login } = await fixture(t);
  const cookies = [];
  for (let user = 1; user <= 32; user++) {
    const cookie = await login(String(user));
    cookies.push(cookie);
    assert.equal(
      (await request("/api/report", { report: { results: user } }, cookie))
        .status,
      200,
    );
  }
  assert.equal(
    (await request("/api/report", { report: {} }, await login("33"))).status,
    429,
  );
  assert.equal(
    (await request("/api/report", { report: {} }, cookies[0])).status,
    200,
  );
});
