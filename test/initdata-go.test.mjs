import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { verifyInitData, InitDataError } from "@lo-ink/miniapp-sdk/server";
import { createHandler } from "../server/app.mjs";
import {
  createGoVerifier,
  GoVerifierUnavailable,
} from "../server/initdata-go.mjs";

const fixture = {
  appKey: "synthetic-app-key",
  appId: "test-app",
  maxAgeSec: 3600,
  nowSec: 1800000000,
};
const fields = new URLSearchParams({
  app_id: fixture.appId,
  auth_date: String(fixture.nowSec),
  user: JSON.stringify({ id: "9007199254740993", first_name: "Unicode 🌍" }),
});
const { createHmac } = await import("node:crypto");
const secret = createHmac("sha256", "WebAppData")
  .update(fixture.appKey)
  .digest();
const check = [...fields.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}=${v}`)
  .join("\n");
fields.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
const vectors = [
  {
    ...fixture,
    raw: fields.toString(),
    expected: { user: { id: "9007199254740993" }, authDate: fixture.nowSec },
  },
];
const vector = vectors.find((item) => item.expected?.user?.id);
const options = {
  appKey: vector.appKey,
  appId: vector.appId,
  maxAgeSec: vector.maxAgeSec,
  nowSec: vector.nowSec,
};

test("compiled Go authenticates the same signed identity as Node and rejects tampered/duplicate launch fields", async () => {
  const verifyGo = createGoVerifier();
  const node = verifyInitData(vector.raw, options);
  const go = await verifyGo(vector.raw, options);
  assert.deepEqual(go, {
    verified: true,
    userId: node.user.id,
    appId: node.appId,
    authDate: node.authDate,
  });
  assert.equal(JSON.stringify(go).includes(vector.appKey), false);
  assert.equal(JSON.stringify(go).includes(vector.raw), false);
  const tampered = new URLSearchParams(vector.raw);
  tampered.set("user", JSON.stringify({ id: "42", first_name: "Tampered" }));
  for (const raw of [tampered.toString(), vector.raw + "&app_id=test-app"]) {
    assert.throws(() => verifyInitData(raw, options), InitDataError);
    await assert.rejects(verifyGo(raw, options), InitDataError);
  }
});

async function server(t, verifyWithGo) {
  const listener = createServer(
    createHandler(
      { LO_APP_ID: vector.appId, LO_APP_KEY: vector.appKey },
      {
        now: () => vector.nowSec,
        verifyWithGo,
      },
    ),
  );
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  return (raw) =>
    fetch(`http://127.0.0.1:${listener.address().port}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sdk-test": "1" },
      body: JSON.stringify({ raw }),
    });
}

test("session is issued only after both real verifiers agree, without returning launch credentials", async (t) => {
  const request = await server(t, createGoVerifier());
  const result = await request(vector.raw);
  assert.equal(result.status, 200);
  assert.ok(result.headers.get("set-cookie"));
  const body = await result.json();
  assert.deepEqual(body.verifiers, ["Node HMAC", "Go HMAC"]);
  assert.equal(body.userId, vector.expected.user.id);
  assert.equal(JSON.stringify(body).includes(vector.appKey), false);
  assert.equal(JSON.stringify(body).includes(vector.raw), false);
});

test("a failing or disagreeing Go verifier cannot mint a session; Node-invalid inputs never reach Go", async (t) => {
  for (const verifyWithGo of [
    async () => {
      throw new GoVerifierUnavailable();
    },
    async () => ({
      verified: true,
      userId: "42",
      appId: vector.appId,
      authDate: vector.expected.authDate,
    }),
  ]) {
    const request = await server(t, verifyWithGo);
    const response = await request(vector.raw);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  let calls = 0;
  const request = await server(t, async () => {
    calls++;
    assert.fail("Invalid Node signature must stop before Go");
  });
  const response = await request("app_id=test-app&hash=invalid");
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(calls, 0);
});

test("Go runner bounds output and execution time without reflecting process diagnostics", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lo-go-verifier-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "process.mjs");
  await writeFile(
    script,
    "process.stderr.write('synthetic-private-diagnostic'); process.stdout.write('secret'.repeat(2000)); process.stdin.resume();",
  );
  const oversized = createGoVerifier({
    binary: process.execPath,
    args: [script],
  });
  await assert.rejects(oversized(vector.raw, options), (error) => {
    assert.ok(error instanceof GoVerifierUnavailable);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  await writeFile(
    script,
    "process.stdin.resume(); setInterval(() => {}, 1000);",
  );
  const hanging = createGoVerifier({
    binary: process.execPath,
    args: [script],
    timeoutMs: 500,
  });
  await assert.rejects(hanging(vector.raw, options), GoVerifierUnavailable);
});
