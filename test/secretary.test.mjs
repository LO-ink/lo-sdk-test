import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretaryFlow } from "../server/secretary.mjs";
const ownerId = "17",
  peerId = "42",
  botId = "1000000000000042",
  connectionId = "0d4d194e-3b2d-4c46-a2b0-55b4be56d9c0",
  now = 1800000000;
async function setup(t, changes = {}) {
  const directory = await mkdtemp(join(tmpdir(), "lo-secretary-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configuration = {
    LO_SECRETARY_TEST_TOKEN: `${botId}:synthetic-test-token`,
    LO_SECRETARY_TEST_OWNER_ID: ownerId,
    LO_SECRETARY_TEST_PEER_ID: peerId,
    LO_SECRETARY_TEST_CONNECTION_ID: connectionId,
    LO_SECRETARY_TEST_STATE: join(directory, "state.json"),
    LO_SECRETARY_TEST_EXCLUSIVE_POLL: "true",
    ...changes,
  };
  const calls = [];
  let updates = [],
    loseResponse = false,
    state = "draft",
    enabled = true,
    foreignOwner = false;
  const fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === "getMe")
      return Response.json({
        ok: true,
        result: {
          id: botId,
          is_bot: true,
          first_name: "Synthetic test",
          username: "synthetic_test",
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        },
      });
    if (method === "getBusinessConnection")
      return Response.json({
        ok: true,
        result: {
          id: connectionId,
          user: { id: foreignOwner ? "18" : ownerId, is_bot: false },
          date: now,
          is_enabled: enabled,
          lo_schema_version: 1,
          lo_policy_version: "3",
          lo_rights: ["receive_messages", "send_messages"],
        },
      });
    if (method === "getUpdates")
      return Response.json({ ok: true, result: updates });
    if (method === "proposeBusinessDraft") {
      const saved = JSON.parse(
        await readFile(configuration.LO_SECRETARY_TEST_STATE, "utf8"),
      );
      assert.equal(saved.intent.requestId, body.lo_request_id);
      assert.equal(saved.attempted, true);
      if (loseResponse) {
        loseResponse = false;
        state = "sent";
        throw new TypeError("Synthetic response lost after commit");
      }
      return Response.json({
        ok: true,
        result: {
          lo_draft_id: "11111111-1111-4111-8111-111111111111",
          business_connection_id: connectionId,
          lo_conversation_id: "71",
          chat_id: peerId,
          lo_source_message_id: "91",
          lo_revision: state === "sent" ? "2" : "1",
          state,
          mode: "review",
          text: body.text,
          reason: "manual_review",
          date: now,
          expires_at: now + 86400,
          lo_secretary_bot_id: botId,
          ...(state === "sent" ? { message_id: "92" } : {}),
        },
      });
    }
    assert.fail(`Unexpected method ${method}`);
  };
  const dependencies = { fetch, now: () => now };
  const flow = createSecretaryFlow(configuration, dependencies);
  const incoming = (challenge, patch = {}) => ({
    update_id: "9007199254740993",
    business_message: {
      message_id: "91",
      date: now,
      from: { id: peerId, is_bot: false },
      chat: { id: peerId, type: "private" },
      text: challenge,
      business_connection_id: connectionId,
      lo_context: {
        conversation_id: "71",
        chat_id: peerId,
        policy_version: "3",
        source_message_id: "91",
        source_revision: "1",
      },
      lo_event_id: "synthetic-challenge-event",
      ...patch,
    },
  });
  return {
    configuration,
    dependencies,
    flow,
    incoming,
    calls,
    setUpdates: (value) => {
      updates = value;
    },
    lose: () => {
      loseResponse = true;
    },
    pause: () => {
      enabled = false;
    },
    foreign: () => {
      foreignOwner = true;
    },
  };
}
test("disabled flow never polls ordinary bots or accepts shared identity", async (t) => {
  const a = await setup(t, { LO_SECRETARY_TEST_STATE: undefined });
  assert.deepEqual(await a.flow(ownerId, { action: "start" }), {
    configured: false,
  });
  const b = await setup(t, { LO_BOT_TOKEN: `${botId}:other-token` });
  assert.deepEqual(await b.flow(ownerId, { action: "start" }), {
    configured: false,
  });
  assert.equal(a.calls.length + b.calls.length, 0);
});
test("owner, connection and request-context substitution fail before proposal", async (t) => {
  const s = await setup(t);
  await assert.rejects(
    s.flow("18", { action: "start" }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    s.flow(ownerId, { action: "start", context: {} }),
    (e) => e.status === 400,
  );
  s.foreign();
  await assert.rejects(
    s.flow(ownerId, { action: "start" }),
    (e) => e.status === 403,
  );
  assert.equal(
    s.calls.some(
      (c) => c.method === "getUpdates" || c.method === "proposeBusinessDraft",
    ),
    false,
  );
});
test("exact challenge, durable proposal and sent evidence survive lost response and restart", async (t) => {
  const s = await setup(t);
  const run = await s.flow(ownerId, { action: "start" });
  assert.equal(run.connectionVerified, true);
  assert.equal(
    (await stat(s.configuration.LO_SECRETARY_TEST_STATE)).mode & 0o777,
    0o600,
  );
  s.setUpdates([s.incoming("Unrelated private text")]);
  assert.equal(
    (await s.flow(ownerId, { action: "incoming", runId: run.runId }))
      .incomingReceived,
    false,
  );
  assert.equal(
    (await readFile(s.configuration.LO_SECRETARY_TEST_STATE, "utf8")).includes(
      "Unrelated private text",
    ),
    false,
  );
  s.setUpdates([s.incoming(run.challenge)]);
  const captured = await s.flow(ownerId, {
    action: "incoming",
    runId: run.runId,
  });
  assert.equal(captured.incomingReceived, true);
  await assert.rejects(
    s.flow(ownerId, { action: "propose", runId: "foreign-run" }),
    (e) => e.status === 404,
  );
  s.lose();
  await assert.rejects(
    s.flow(ownerId, { action: "propose", runId: run.runId }),
  );
  const restored = createSecretaryFlow(s.configuration, s.dependencies);
  assert.equal(
    (await restored(ownerId, { action: "status" })).outcome,
    "unavailable",
  );
  const sent = await restored(ownerId, { action: "verify", runId: run.runId });
  assert.equal(sent.outcome, "sent");
  assert.equal(sent.draft.messageId, "92");
  const requests = s.calls.filter((c) => c.method === "proposeBusinessDraft");
  assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(requests[0].body.lo_draft_reason, "manual_review");
  const polls = s.calls.filter((c) => c.method === "getUpdates");
  assert.equal(polls[1].body.offset, "9007199254740994");
});
test("pause and foreign peer do not create a draft; review receipt is not sent evidence", async (t) => {
  const s = await setup(t);
  const run = await s.flow(ownerId, { action: "start" });
  s.setUpdates([
    s.incoming(run.challenge, { from: { id: "43", is_bot: false } }),
  ]);
  assert.equal(
    (await s.flow(ownerId, { action: "incoming", runId: run.runId }))
      .incomingReceived,
    false,
  );
  await assert.rejects(
    s.flow(ownerId, { action: "propose", runId: run.runId }),
    (e) => e.status === 409,
  );
  s.setUpdates([s.incoming(run.challenge)]);
  await s.flow(ownerId, { action: "incoming", runId: run.runId });
  assert.equal(
    (await s.flow(ownerId, { action: "propose", runId: run.runId })).outcome,
    "received",
  );
  s.pause();
  await assert.rejects(
    s.flow(ownerId, { action: "verify", runId: run.runId }),
    (e) => e.status === 403,
  );
  assert.equal(
    s.calls.filter((c) => c.method === "proposeBusinessDraft").length,
    1,
  );
});
test("private storage lock and changed configuration fail closed", async (t) => {
  const s = await setup(t);
  await s.flow(ownerId, { action: "start" });
  await writeFile(
    `${s.configuration.LO_SECRETARY_TEST_STATE}.lock`,
    "synthetic orphan lock",
    { mode: 0o600 },
  );
  await assert.rejects(
    s.flow(ownerId, { action: "status" }),
    (e) => e.status === 409,
  );
  await rm(`${s.configuration.LO_SECRETARY_TEST_STATE}.lock`);
  const other = createSecretaryFlow(
    { ...s.configuration, LO_SECRETARY_TEST_PEER_ID: "43" },
    s.dependencies,
  );
  await assert.rejects(
    other(ownerId, { action: "status" }),
    (e) => e.status === 409,
  );
});

test("corrupted durable intent cannot change manual review, scope, key or text", async (t) => {
  const s = await setup(t);
  const run = await s.flow(ownerId, { action: "start" });
  s.setUpdates([s.incoming(run.challenge)]);
  await s.flow(ownerId, { action: "incoming", runId: run.runId });
  const original = JSON.parse(
    await readFile(s.configuration.LO_SECRETARY_TEST_STATE, "utf8"),
  );
  for (const patch of [
    { reason: "template" },
    { connectionId: "11111111-1111-4111-8111-111111111111" },
    { requestId: "replacement-key" },
    { text: "Other reply" },
    { context: { ...original.intent.context, chatId: "43" } },
  ]) {
    await writeFile(
      s.configuration.LO_SECRETARY_TEST_STATE,
      JSON.stringify({ ...original, intent: { ...original.intent, ...patch } }),
      { mode: 0o600 },
    );
    const restored = createSecretaryFlow(s.configuration, s.dependencies);
    await assert.rejects(
      restored(ownerId, { action: "propose", runId: run.runId }),
      (e) => e.status === 409,
    );
  }
  assert.equal(
    s.calls.some((c) => c.method === "proposeBusinessDraft"),
    false,
  );
});

test("committed sending evidence remains available after pause without another call", async (t) => {
  const s = await setup(t);
  const run = await s.flow(ownerId, { action: "start" });
  s.setUpdates([s.incoming(run.challenge)]);
  await s.flow(ownerId, { action: "incoming", runId: run.runId });
  s.lose();
  await assert.rejects(
    s.flow(ownerId, { action: "propose", runId: run.runId }),
  );
  const sent = await s.flow(ownerId, { action: "verify", runId: run.runId });
  const count = s.calls.length;
  s.pause();
  const restored = createSecretaryFlow(s.configuration, s.dependencies);
  assert.deepEqual(
    await restored(ownerId, { action: "verify", runId: run.runId }),
    sent,
  );
  assert.equal(sent.confirmedAt, now);
  assert.equal(s.calls.length, count);
});
