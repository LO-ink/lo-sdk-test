import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const image = process.argv[2];
if (!image) throw new Error("Container image argument is required");
const revision = process.env.BUILD_REVISION ?? "local";
const name = `lo-sdk-test-smoke-${randomUUID()}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
try {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "-p",
    "127.0.0.1::5407",
    image,
  );
  const container = JSON.parse(docker("inspect", name))[0];
  assert.equal(container.Config.User, "node");
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  const port = container.NetworkSettings.Ports["5407/tcp"][0].HostPort;
  const origin = `http://127.0.0.1:${port}`;
  let response;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      response = await fetch(origin + "/api/status");
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(response?.status, 200);
  const status = await response.json();
  assert.equal(status.appConfigured, false);
  assert.equal(status.botConfigured, false);
  assert.ok(status.signatureVerifiers.includes("Go HMAC"));
  const release = await fetch(origin + "/release.json");
  assert.equal(release.status, 200);
  assert.equal((await release.json()).revision, revision);
  assert.equal((await fetch(origin + "/")).status, 200);
  console.log(
    "Container startup, Go verifier, read-only runtime and release identity verified",
  );
} finally {
  try {
    docker("rm", "-f", name);
  } catch {}
}
