import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { createHandler } from "../server/app.mjs";
import { conformance } from "../server/conformance.mjs";
const appKey = "synthetic-public-test-key";
const now = 1800000000;
function signed(overrides = {}) {
  const params = {
    app_id: "test-app",
    auth_date: String(now),
    user: '{"id":9007199254740993,"first_name":"Test"}',
    ...overrides,
  };
  const joined = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(appKey).digest();
  return new URLSearchParams({
    ...params,
    hash: createHmac("sha256", secret).update(joined).digest("hex"),
  }).toString();
}
async function fixture(
  t,
  config = {},
  botFetch = () => assert.fail("No network expected"),
  clock = () => now,
) {
  const server = createServer(
    createHandler(
      { LO_APP_ID: "test-app", LO_APP_KEY: appKey, ...config },
      { now: clock, fetch: botFetch },
    ),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return (path, body, cookie = "", extra = {}) =>
    fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-sdk-test": "1",
        ...(cookie ? { cookie } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
test("bad signature, wrong app, expired launch and foreign origins fail closed", async (t) => {
  const request = await fixture(t);
  for (const raw of [
    signed().replace("9007199254740993", "42"),
    signed({ app_id: "other-app" }),
    signed({ auth_date: String(now - 3601) }),
  ]) {
    const response = await request("/api/session", { raw });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  const foreign = await request("/api/session", { raw: signed() }, "", {
    origin: "https://evil.example.test",
  });
  assert.equal(foreign.status, 403);
  const noHeader = await request("/api/session", { raw: signed() }, "", {
    "x-sdk-test": "0",
  });
  assert.equal(noHeader.status, 403);
});
test("valid launch sets a private session and sends only to its exact signed user", async (t) => {
  const calls = [];
  const request = await fixture(
    t,
    {
      LO_BOT_TOKEN: "42:synthetic-test-token",
      LO_APP_URL: "https://app.example.test/",
    },
    async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return Response.json({
        ok: true,
        result: {
          message_id: 1,
          date: now,
          chat: { id: "9007199254740993", type: "private" },
          text: "test",
        },
      });
    },
  );
  const session = await request("/api/session", { raw: signed() });
  assert.equal(session.status, 200);
  const setCookie = session.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(";")[0];
  assert.equal((await session.json()).userId, "9007199254740993");
  assert.equal(
    (await request("/api/bot", { operation: "sendMessage" }, cookie)).status,
    403,
  );
  assert.equal(
    (await request("/api/consent", { allowed: true }, cookie)).status,
    200,
  );
  const response = await request(
    "/api/bot",
    { operation: "sendMessage", conversationId: "attacker-id" },
    cookie,
  );
  assert.equal(response.status, 200);
  assert.equal(calls[0].chat_id, "9007199254740993");
  assert.deepEqual(calls[0].reply_markup, {
    inline_keyboard: [
      [
        {
          text: "Открыть тесты",
          web_app: { url: "https://app.example.test/" },
        },
      ],
    ],
  });
  assert.equal(
    (await request("/api/bot", { operation: "sendMessage" }, cookie)).status,
    429,
  );
  assert.equal(calls.length, 1);
});
test("status never exposes secrets, unauthenticated sends fail, and synthetic checks are clearly marked", async (t) => {
  const request = await fixture(t, {
    LO_BOT_TOKEN: "42:synthetic-test-token",
    LO_APP_URL: "https://app.example.test/",
  });
  const status = await (await request("/api/status")).text();
  assert.equal(status.includes(appKey), false);
  assert.equal(status.includes("synthetic-test-token"), false);
  assert.equal(
    (await request("/api/bot", { operation: "sendPhoto" })).status,
    401,
  );
  const result = await (
    await request("/api/bot", { operation: "conformance" })
  ).json();
  assert.equal(result.mode, "synthetic");
  assert.equal(result.passed, true);
  assert.equal(result.networkCalls, 0);
});
test("optional allowlist rejects a valid unauthorized user", async (t) => {
  const request = await fixture(t, { LO_TEST_USER_IDS: "42" });
  assert.equal((await request("/api/session", { raw: signed() })).status, 403);
});
test("disabled configuration returns a useful error without inventing verification", async (t) => {
  const request = await fixture(t, { LO_APP_ID: "", LO_APP_KEY: "" });
  assert.equal((await request("/api/session", { raw: signed() })).status, 503);
});
test("error conformance never talks to a real platform", async () => {
  const result = await conformance();
  assert.equal(result.passed, true);
  assert.equal(result.networkCalls, 0);
  assert.equal(result.results.length, 14);
});

test("one-shot updates expose only the current verified user's messages", async (t) => {
  const request = await fixture(
    t,
    {
      LO_BOT_TOKEN: "42:synthetic-test-token",
      LO_APP_URL: "https://app.example.test/",
    },
    async () =>
      Response.json({
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 1,
              date: now,
              chat: { id: "9007199254740993", type: "private" },
              text: "own",
            },
          },
          {
            update_id: 2,
            message: {
              message_id: 2,
              date: now,
              chat: { id: "42", type: "private" },
              text: "foreign",
            },
          },
          {
            update_id: 3,
            message: {
              chat: { id: "9007199254740993" },
              from: { id: "9007199254740993" },
              web_app_data: { data: "own-app-data", button_text: "SDK" },
            },
          },
          {
            update_id: 4,
            message: {
              chat: { id: "42" },
              web_app_data: { data: "foreign-app-data" },
            },
          },
          {
            update_id: 5,
            callback_query: {
              id: "own-callback",
              from: { id: "9007199254740993" },
              data: "confirm",
            },
          },
          {
            update_id: 6,
            callback_query: {
              id: "foreign-callback",
              from: { id: "42" },
              data: "private",
            },
          },
        ],
      }),
  );
  const login = await request("/api/session", { raw: signed() });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await request("/api/consent", { allowed: true }, cookie);
  const response = await request(
    "/api/bot",
    { operation: "getUpdates" },
    cookie,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.length, 3);
  assert.equal(body.result[0].message.text, "own");
  assert.equal(body.result[1].appData.data, "own-app-data");
  assert.equal(Object.hasOwn(body.result[1].appData, "messageId"), false);
  assert.equal(body.result[2].callback.id, "own-callback");
  assert.equal(JSON.stringify(body).includes("foreign-"), false);
});

test("platform 403 revokes server consent and prevents the next send", async (t) => {
  let calls = 0;
  const request = await fixture(
    t,
    {
      LO_BOT_TOKEN: "42:synthetic-test-token",
      LO_APP_URL: "https://app.example.test/",
    },
    async () => {
      calls++;
      return Response.json(
        { ok: false, error_code: 403, description: "Forbidden" },
        { status: 403 },
      );
    },
  );
  const login = await request("/api/session", { raw: signed() });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await request("/api/consent", { allowed: true }, cookie);
  const first = await request("/api/bot", { operation: "sendMessage" }, cookie);
  assert.equal(first.status, 403);
  assert.equal((await first.json()).code, "forbidden");
  const second = await request(
    "/api/bot",
    { operation: "sendMessage" },
    cookie,
  );
  assert.equal(second.status, 403);
  assert.equal(calls, 1);
});

test("native report download requires a signed session, expires and replaces the previous file", async (t) => {
  let currentTime = now;
  const request = await fixture(t, {}, undefined, () => currentTime);
  const report = {
    appVersion: "0.3.0",
    bridgeCoverage: [{ bridge: "native", confirmed: 1, total: 4, percent: 25 }],
    adapter: "lo",
    sdkBuild: {
      source: "merged-main",
      packages: [{ name: "@lo-ink/bot-sdk", version: "0.3.0" }],
    },
    automatedRun: {
      state: "finished",
      checks: [
        {
          state: "failed",
          detail: "wrong value",
          token: "synthetic-run-secret",
        },
      ],
    },
    results: { snapshot: { token: "synthetic-secret", status: "pass" } },
    initData: "synthetic-private-launch",
  };
  assert.equal((await request("/api/report", { report })).status, 401);
  const login = await request("/api/session", { raw: signed() });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await request("/api/report", { report }, cookie, {
        origin: "https://evil.example.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/report", { report: null }, cookie)).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/report",
        { report: { log: "x".repeat(512 << 10) } },
        cookie,
      )
    ).status,
    413,
  );
  const first = await (await request("/api/report", { report }, cookie)).json();
  assert.match(first.path, /^\/reports\/[\w-]{32}\.json$/);
  const file = await request(first.path);
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-disposition"), /attachment/);
  assert.equal(file.headers.get("cache-control"), "no-store");
  const text = await file.text();
  assert.equal(text.includes("synthetic-secret"), false);
  assert.equal(text.includes("synthetic-private-launch"), false);
  assert.equal(JSON.parse(text).results.snapshot.status, "pass");
  assert.equal(JSON.parse(text).automatedRun.checks[0].state, "failed");
  assert.equal(JSON.parse(text).sdkBuild.packages[0].version, "0.3.0");
  assert.equal(JSON.parse(text).appVersion, "0.3.0");
  assert.equal(JSON.parse(text).bridgeCoverage[0].percent, 25);
  assert.equal(text.includes("synthetic-run-secret"), false);
  const second = await (
    await request("/api/report", { report }, cookie)
  ).json();
  assert.equal((await request(first.path)).status, 404);
  assert.equal((await request(second.path)).status, 200);
  currentTime += 60;
  assert.equal((await request(second.path)).status, 404);
});

test("media/file checks use session-owned IDs and metadata; download reports bytes and digest", async (t) => {
  let clock = now;
  const calls = [];
  let bytes = new Uint8Array([1, 2, 3]);
  const request = await fixture(
    t,
    {
      LO_BOT_TOKEN: "42:synthetic-test-token",
      LO_APP_URL: "https://app.example.test/",
    },
    async (url, options) => {
      const operation = url.split("/").at(-1);
      calls.push(operation);
      if (operation === "sendDocument") {
        assert.equal(options.body.get("chat_id"), "9007199254740993");
        assert.equal(options.body.get("document").size, 3);
        return Response.json({
          ok: true,
          result: {
            message_id: 7,
            date: now,
            chat: { id: "9007199254740993", type: "private" },
            document: { file_id: "own-document" },
          },
        });
      }
      if (operation === "getFile") {
        assert.equal(JSON.parse(options.body).file_id, "own-document");
        return Response.json({
          ok: true,
          result: {
            file_id: "own-document",
            file_unique_id: "fixture-unique",
            file_size: 3,
            file_path: "documents/fixture",
          },
        });
      }
      assert.equal(operation, "fixture");
      assert.ok(url.endsWith("/documents/fixture"));
      return new Response(bytes);
    },
    () => clock,
  );
  const login = await request("/api/session", { raw: signed() });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const login2 = await request("/api/session", { raw: signed() });
  const isolatedCookie = login2.headers.get("set-cookie").split(";")[0];
  await request("/api/consent", { allowed: true }, cookie);
  let response = await request(
    "/api/bot",
    { operation: "sendDocument", file: { data: "AQID", name: "fixture.bin" } },
    cookie,
  );
  assert.equal(response.status, 200);
  clock += 3;
  response = await request(
    "/api/bot",
    { operation: "getFile", fileId: "attacker-id" },
    cookie,
  );
  assert.equal(response.status, 200);
  clock += 3;
  response = await request(
    "/api/bot",
    { operation: "downloadFile", path: "attacker/path" },
    cookie,
  );
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.equal(result.bytes, 3);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.verifiedContent, true);
  bytes = new Uint8Array([3, 2, 1]);
  clock += 3;
  response = await request("/api/bot", { operation: "downloadFile" }, cookie);
  assert.equal(response.status, 502);
  clock += 3;
  response = await request(
    "/api/bot",
    { operation: "getFile", fileId: "own-document" },
    isolatedCookie,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(calls, ["sendDocument", "getFile", "fixture", "fixture"]);
});

test("document album uses an owned reference and a distinct uploaded document", async (t) => {
  let clock = now;
  let album = false;
  const request = await fixture(
    t,
    {
      LO_BOT_TOKEN: "42:synthetic-test-token",
      LO_APP_URL: "https://app.example.test/",
    },
    async (url, options) => {
      const operation = url.split("/").at(-1);
      const result = {
        message_id: 7,
        date: now,
        chat: { id: "9007199254740993", type: "private" },
      };
      if (operation === "sendDocument")
        return Response.json({
          ok: true,
          result: { ...result, document: { file_id: "own-document" } },
        });
      assert.equal(operation, "sendMediaGroup");
      const media = JSON.parse(options.body.get("media"));
      assert.equal(media[0].media, "own-document");
      assert.equal(media[1].media, "attach://media_1");
      const second = options.body.get("media_1");
      assert.equal(second.name, "sdk-test-second.txt");
      assert.equal(second.type, "text/plain");
      assert.match(await second.text(), /второй документ/);
      album = true;
      return Response.json({
        ok: true,
        result: [
          { ...result, document: { file_id: "own-document" } },
          { ...result, document: { file_id: "second-document" } },
        ],
      });
    },
    () => clock,
  );
  const login = await request("/api/session", { raw: signed() });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await request("/api/consent", { allowed: true }, cookie);
  assert.equal(
    (
      await request(
        "/api/bot",
        {
          operation: "sendDocument",
          file: { data: "AQID", name: "fixture.bin" },
        },
        cookie,
      )
    ).status,
    200,
  );
  clock += 3;
  const response = await request(
    "/api/bot",
    { operation: "documentAlbum" },
    cookie,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.length, 2);
  assert.equal(album, true);
});

test("sendData verification matches only this attempt and signed owner without advancing updates or returning messages", async (t) => {
  let clock = now;
  const code = "lo-sdk-test:12345678-1234-1234-1234-123456789abc";
  const other = "lo-sdk-test:87654321-1234-1234-1234-123456789abc";
  let matched = false;
  const calls = [];
  const request = await fixture(
    t,
    {
      LO_BOT_TOKEN: "42:synthetic-test-token",
      LO_APP_URL: "https://app.example.test/",
    },
    async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return Response.json({
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              chat: { id: "9007199254740993" },
              web_app_data: { data: "sdk-test" },
            },
          },
          {
            update_id: 2,
            message: {
              chat: { id: "9007199254740993" },
              web_app_data: { data: other },
            },
          },
          {
            update_id: 3,
            message: { chat: { id: "42" }, web_app_data: { data: code } },
          },
          {
            update_id: 4,
            message: {
              chat: { id: "9007199254740993" },
              from: { id: "42" },
              web_app_data: { data: code },
            },
          },
          ...(matched
            ? [
                {
                  update_id: 5,
                  message: {
                    chat: { id: "9007199254740993" },
                    from: { id: "9007199254740993" },
                    web_app_data: { data: code },
                  },
                },
              ]
            : []),
        ],
      });
    },
    () => clock,
  );
  const body = { data: code, appId: "test-app", userId: "9007199254740993" };
  assert.equal((await request("/api/send-data/verify", body)).status, 401);
  const login = await request("/api/session", { raw: signed() });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  for (const changed of [
    { data: "sdk-test" },
    { userId: "42" },
    { appId: "other" },
  ]) {
    assert.ok(
      [400, 403].includes(
        (
          await request(
            "/api/send-data/verify",
            { ...body, ...changed },
            cookie,
          )
        ).status,
      ),
    );
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(
    await (await request("/api/send-data/verify", body, cookie)).json(),
    { found: false },
  );
  matched = true;
  clock += 3;
  assert.deepEqual(
    await (await request("/api/send-data/verify", body, cookie)).json(),
    { found: true },
  );
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(Object.hasOwn(call, "offset"), false);
    assert.equal(call.timeout, 0);
    assert.equal(call.limit, 100);
  }
});

test("public conformance ignores expired cookies while authenticated methods remain closed", async (t) => {
  const request = await fixture(t);
  const stale = "sdk_test=expired-synthetic";
  const response = await request(
    "/api/bot",
    { operation: "conformance" },
    stale,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, "synthetic");
  assert.equal(
    (await request("/api/bot", { operation: "sendMessage" }, stale)).status,
    401,
  );
});

test("same-run reauthentication rotates cookies, preserves owned resources and requires fresh consent", async (t) => {
  let clock = now;
  const sends = [];
  const request = await fixture(
    t,
    {
      LO_BOT_TOKEN: "42:synthetic-test-token",
      LO_APP_URL: "https://app.example.test/",
    },
    async (url, options) => {
      const operation = url.split("/").at(-1);
      const body = JSON.parse(options.body);
      sends.push({ operation, body });
      return Response.json({
        ok: true,
        result: {
          message_id: 77,
          date: now,
          chat: { id: "9007199254740993", type: "private" },
          text: body.text,
        },
      });
    },
    () => clock,
  );
  const runId = "11111111-1111-4111-8111-111111111111";
  const first = await request("/api/session", { raw: signed(), runId });
  const cookie = first.headers.get("set-cookie").split(";")[0];
  await request("/api/consent", { allowed: true }, cookie);
  assert.equal(
    (await request("/api/bot", { operation: "sendMessage" }, cookie)).status,
    200,
  );
  const resumed = await request(
    "/api/session",
    { raw: signed(), runId, resume: true },
    cookie,
  );
  assert.equal(resumed.status, 200);
  assert.deepEqual((await resumed.json()).resources, {
    message: true,
    files: [],
    metadata: false,
  });
  const nextCookie = resumed.headers.get("set-cookie").split(";")[0];
  assert.notEqual(nextCookie, cookie);
  assert.equal(
    (await request("/api/consent", { allowed: true }, cookie)).status,
    401,
  );
  clock += 3;
  assert.equal(
    (await request("/api/bot", { operation: "editMessage" }, nextCookie))
      .status,
    403,
  );
  await request("/api/consent", { allowed: true }, nextCookie);
  assert.equal(
    (await request("/api/bot", { operation: "editMessage" }, nextCookie))
      .status,
    200,
  );
  assert.deepEqual(
    sends.map((item) => item.operation),
    ["sendMessage", "editMessageText"],
  );
  assert.equal(sends[1].body.message_id, "77");
  for (const [raw, id] of [
    [signed({ user: '{"id":202,"first_name":"Other"}' }), runId],
    [signed(), "22222222-2222-4222-8222-222222222222"],
  ]) {
    const isolated = await request(
      "/api/session",
      { raw, runId: id, resume: true },
      nextCookie,
    );
    assert.equal(isolated.status, 200);
    assert.deepEqual((await isolated.json()).resources, {
      message: false,
      files: [],
      metadata: false,
    });
  }
});

test("all cookies for one user share the bot budget, including resume rotation and expiry", async (t) => {
  let clock = now;
  const calls = [];
  const request = await fixture(
    t,
    {
      LO_BOT_TOKEN: "42:synthetic-test-token",
      LO_APP_URL: "https://app.example.test/",
    },
    async (url, options) => {
      calls.push(url);
      return Response.json({
        ok: true,
        result: {
          message_id: 1,
          date: now,
          chat: { id: JSON.parse(options.body).chat_id, type: "private" },
          text: "fixture",
        },
      });
    },
    () => clock,
  );
  const runId = "33333333-3333-4333-8333-333333333333";
  const login = async (cookie = "", resume = false, raw = signed()) => {
    const response = await request(
      "/api/session",
      { raw, runId, resume },
      cookie,
    );
    assert.equal(response.status, 200);
    const next = response.headers.get("set-cookie").split(";")[0];
    await request("/api/consent", { allowed: true }, next);
    return next;
  };
  const a = await login(),
    b = await login();
  const simultaneous = await Promise.all(
    [a, b].map((cookie) =>
      request("/api/bot", { operation: "sendMessage" }, cookie),
    ),
  );
  assert.deepEqual(
    simultaneous.map((response) => response.status).sort(),
    [200, 429],
  );
  const rotated = await login(b, true);
  assert.equal(
    (await request("/api/bot", { operation: "sendMessage" }, rotated)).status,
    429,
  );
  assert.equal(
    (
      await request(
        "/api/send-data/verify",
        {
          data: "lo-sdk-test:11111111-1111-4111-8111-111111111111",
          userId: "9007199254740993",
          appId: "test-app",
        },
        rotated,
      )
    ).status,
    429,
  );
  clock += 2;
  assert.equal(
    (await request("/api/bot", { operation: "sendMessage" }, rotated)).status,
    200,
  );
  clock = now + 3599;
  assert.equal(
    (await request("/api/bot", { operation: "sendMessage" }, rotated)).status,
    200,
  );
  clock++;
  const fresh = await login("", false, signed({ auth_date: String(clock) }));
  assert.equal(
    (await request("/api/bot", { operation: "sendMessage" }, fresh)).status,
    429,
  );
  clock++;
  assert.equal(
    (await request("/api/bot", { operation: "sendMessage" }, fresh)).status,
    200,
  );
  assert.equal(calls.length, 4);
});
