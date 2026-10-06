import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const image = `ghcr.io/lo-ink/lo-sdk-test@${digest}`;
const request = `deploy ${digest} ${revision} ci-user`;
const source = readFileSync(
  new URL("../deploy/release.sh", import.meta.url),
  "utf8",
);

function run({ scenario = "success", command = request } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lo-sdk-deployment-test-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "calls.jsonl");
    const mock = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const tool = basename(process.argv[1]), args = process.argv.slice(2), scenario = process.env.SCENARIO;
appendFileSync(process.env.CALL_LOG, JSON.stringify({tool,args}) + "\\n");
if (tool === "git") {
  if (scenario === "github-down") process.exit(1);
  console.log((scenario === "stale" ? "c".repeat(40) : "a".repeat(40)) + "\\trefs/heads/main");
} else if (tool === "curl") {
  console.log(JSON.stringify({revision: scenario === "public-mismatch" ? "c".repeat(40) : "a".repeat(40)}));
} else if (tool === "docker") {
  if (args[0] === "login") { for await (const chunk of process.stdin) {} }
  else if (args[0] === "pull" && scenario === "pull-fails") process.exit(1);
  else if (args[0] === "image") console.log(args[3].includes("revision") ? (scenario === "bad-label" ? "c".repeat(40) : "a".repeat(40)) : "https://github.com/LO-ink/lo-sdk-test");
  else if (args[0] === "inspect") console.log(args[2].includes("Health") ? "healthy" : (scenario === "already-deployed" ? process.env.NEW_IMAGE : "lo-sdk-test:previous"));
  else if (args[0] === "compose") {
    if (args.includes("ps")) console.log("production-container");
    if (args.includes("up") && scenario === "unhealthy" && process.env.SDK_TEST_IMAGE === process.env.NEW_IMAGE) process.exit(1);
    if (args.includes("up")) appendFileSync(process.env.CALL_LOG, JSON.stringify({switchTo:process.env.SDK_TEST_IMAGE}) + "\\n");
  }
}
`;
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    for (const tool of ["git", "curl", "docker", "flock", "sleep"])
      writeFileSync(join(bin, tool), mock, { mode: 0o755 });
    const script = join(root, "release.sh");
    writeFileSync(
      script,
      source
        .replace(/^PATH=.*$/m, `PATH=${bin}:${process.env.PATH}`)
        .replace("DEPLOY_ROOT=/opt/lo-sdk-test", `DEPLOY_ROOT=${root}`),
    );
    const result = spawnSync("bash", [script, command], {
      encoding: "utf8",
      input: "ephemeral-test-credential",
      timeout: 15_000,
      env: {
        ...process.env,
        SCENARIO: scenario,
        CALL_LOG: log,
        NEW_IMAGE: image,
      },
    });
    assert.equal(result.error, undefined);
    let calls = [];
    try {
      calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    } catch {}
    let receipt;
    try {
      receipt = JSON.parse(
        readFileSync(join(root, "current-release.json"), "utf8"),
      );
    } catch {}
    const switches = calls.filter((x) => x.switchTo).map((x) => x.switchTo);
    return { ...result, calls, switches, receipt };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("deployment rejects malformed commands before contacting services", () => {
  for (const command of [
    "",
    "sh",
    `${request} extra`,
    `${request}\nanything`,
    `deploy invalid ${revision} ci-user`,
  ]) {
    const result = run({ command });
    assert.equal(result.status, 64);
    assert.deepEqual(result.calls, []);
  }
});
test("stale releases skip; GitHub failures stop before registry access or production mutation", () => {
  for (const scenario of ["stale", "github-down"]) {
    const result = run({ scenario });
    assert.equal(result.status, scenario === "stale" ? 0 : 69);
    assert.ok(
      result.calls.every((x) => x.tool === "git" || x.tool === "flock"),
    );
    assert.deepEqual(result.switches, []);
  }
});
test("registry errors and mismatched provenance cannot replace production", () => {
  for (const scenario of ["pull-fails", "bad-label"]) {
    const result = run({ scenario });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.switches, []);
    assert.equal(result.receipt, undefined);
  }
});
test("unhealthy images and incorrect public revision restore the previous release", () => {
  for (const scenario of ["unhealthy", "public-mismatch"]) {
    const result = run({ scenario });
    assert.equal(result.status, 1);
    assert.equal(result.switches.at(-1), "lo-sdk-test:previous");
    assert.equal(result.receipt, undefined);
  }
});
test("successful deployment records the exact digest and revision; identical release is idempotent", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.switches, [image]);
  assert.equal(result.receipt.image, image);
  assert.equal(result.receipt.revision, revision);
  const retry = run({ scenario: "already-deployed" });
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(retry.switches, []);
});
