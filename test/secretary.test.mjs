import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretaryFlow } from "../server/secretary.mjs";

const ownerId = "17";
test("retired native review actions preserve unknown outcomes and never call a bot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lo-secretary-retired-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const before = JSON.stringify({
    runId: "11111111-1111-4111-8111-111111111111",
    outcome: "unknown",
    attempted: true,
    intent: { requestId: "original-request", text: "Synthetic old proposal" },
    draft: { id: "original-draft", state: "draft", revision: "1" },
  });
  await writeFile(path, before, { mode: 0o600 });
  await writeFile(`${path}.lock`, "preserved synthetic lock", { mode: 0o600 });
  let networkCalls = 0;
  const flow = createSecretaryFlow(
    {
      LO_SECRETARY_TEST_OWNER_ID: ownerId,
      LO_SECRETARY_TEST_STATE: path,
      LO_SECRETARY_TEST_TOKEN: "1000000000000042:synthetic-token",
      LO_SECRETARY_TEST_EXCLUSIVE_POLL: "true",
    },
    {
      fetch: async () => {
        networkCalls++;
        assert.fail("No network after retirement");
      },
    },
  );
  for (const action of ["status", "start", "incoming", "propose", "verify"])
    await assert.rejects(
      flow(ownerId, { action, runId: "old-run" }),
      (error) => error.status === 410,
    );
  assert.equal(networkCalls, 0);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(
    await readFile(`${path}.lock`, "utf8"),
    "preserved synthetic lock",
  );
  assert.deepEqual((await readdir(directory)).sort(), [
    "state.json",
    "state.json.lock",
  ]);
});

test("retired route retains owner isolation and does not read payload", async () => {
  let reads = 0;
  const payload = {
    get action() {
      reads++;
      throw new Error("Must not read legacy payload");
    },
  };
  const flow = createSecretaryFlow({ LO_SECRETARY_TEST_OWNER_ID: ownerId });
  await assert.rejects(flow("18", payload), (error) => error.status === 403);
  for (const input of [undefined, null, {}, payload])
    await assert.rejects(flow(ownerId, input), (error) => error.status === 410);
  assert.equal(reads, 0);
});

test("missing legacy settings cannot enable polling or silently claim success", async () => {
  const flow = createSecretaryFlow({});
  await assert.rejects(
    flow(ownerId, { action: "start" }),
    (error) => error.status === 410,
  );
});
