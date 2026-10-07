import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const imageName = process.argv[2];
if (!imageName) throw new Error("Container image argument is required");
const prefix = `lo-upload-budget-${randomUUID()}`;
const names = ["sink", "server", "client"].map((role) => `${prefix}-${role}`);
const fixture = fileURLToPath(
  new URL("./upload-budget-fixture.mjs", import.meta.url),
);
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
const imageMetadata = JSON.parse(docker("image", "inspect", imageName))[0];
const image = imageMetadata.Id;
const revision =
  imageMetadata.Config.Labels["org.opencontainers.image.revision"];
assert.ok(revision, "Built image must declare its revision");
console.log(JSON.stringify({ image, revision }));
const common = [
  "--platform=linux/amd64",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--mount",
  `type=bind,source=${fixture},destination=/fixture.mjs,readonly`,
];
try {
  // Sharing a network namespace with no external interface prevents live API calls.
  docker(
    "run",
    "-d",
    "--name",
    names[0],
    "--network=none",
    ...common,
    image,
    "node",
    "/fixture.mjs",
    "sink",
  );
  docker(
    "run",
    "-d",
    "--name",
    names[1],
    "--network",
    `container:${names[0]}`,
    ...common,
    "--mount",
    "type=volume,destination=/var/lib/lo-sdk-test",
    "--memory=256m",
    "--memory-swap=256m",
    "--cpus=0.5",
    "--pids-limit=64",
    image,
    "node",
    "/fixture.mjs",
    "server",
  );
  const configuration = JSON.parse(docker("inspect", names[1]))[0];
  assert.equal(configuration.Config.User, "node");
  assert.equal(configuration.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal(
    configuration.HostConfig.MemorySwap,
    configuration.HostConfig.Memory,
  );
  assert.equal(configuration.HostConfig.ReadonlyRootfs, true);
  process.stdout.write(
    docker(
      "run",
      "--name",
      names[2],
      "--network",
      `container:${names[0]}`,
      ...common,
      "--env",
      `BUILD_REVISION=${revision}`,
      image,
      "node",
      "/fixture.mjs",
      "client",
    ),
  );
  assert.equal(docker("wait", names[1]).trim(), "0");
  const state = JSON.parse(docker("inspect", names[1]))[0].State;
  assert.equal(state.OOMKilled, false);
  process.stdout.write(docker("logs", names[1]));
  console.log(
    "Upload budget verified: five 50 MiB uploads, concurrent refusal, bounded reports, health and cleanup",
  );
} catch (error) {
  for (const name of names) {
    try {
      process.stderr.write(docker("logs", name));
    } catch {}
  }
  throw error;
} finally {
  for (const name of names.reverse()) {
    try {
      docker("rm", "-f", "-v", name);
    } catch {}
  }
}
