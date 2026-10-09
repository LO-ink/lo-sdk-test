import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Vite embeds only an explicit full source revision or local identity", () => {
  for (const revision of [
    undefined,
    "local",
    "a".repeat(40),
    "bad",
    "A".repeat(40),
    "",
  ]) {
    const env = { ...process.env };
    if (revision === undefined) delete env.BUILD_REVISION;
    else env.BUILD_REVISION = revision;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        "import config from './vite.config.ts'; console.log(config.define.__BUILD_REVISION__)",
      ],
      {
        cwd: new URL("../", import.meta.url),
        env,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    const valid =
      revision === undefined ||
      revision === "local" ||
      revision === "a".repeat(40);
    if (valid) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout), revision ?? "local");
    } else {
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /BUILD_REVISION must be a full Git commit or local/,
      );
    }
  }
});
