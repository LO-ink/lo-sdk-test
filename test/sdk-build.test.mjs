import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const readJson = (relative) =>
  JSON.parse(readFileSync(new URL(relative, root), "utf8"));

test("reported SDK versions and integrity match the public registry lock and installed packages", () => {
  const build = readJson("sdk-build.json");
  const manifest = readJson("package.json");
  const lock = readJson("package-lock.json");
  const declared = Object.keys(manifest.dependencies).filter((name) =>
    name.startsWith("@lo-ink/"),
  );
  assert.equal(build.appVersion, manifest.version);
  assert.equal(build.source, "npm-registry");
  assert.deepEqual(
    build.packages.map((entry) => entry.name).sort(),
    declared.sort(),
  );
  assert.deepEqual(
    build.repositories.map((repo) => repo.name).sort(),
    [...new Set(build.packages.map((entry) => entry.repository))].sort(),
  );
  for (const repo of build.repositories)
    assert.equal(repo.url, `https://github.com/LO-ink/${repo.name}`);
  for (const entry of build.packages) {
    assert.match(entry.sourceCommit, /^[a-f0-9]{40}$/, entry.name);
    assert.ok(
      build.repositories.some((repo) => repo.name === entry.repository),
      entry.name,
    );
    assert.equal(manifest.dependencies[entry.name], entry.version, entry.name);
    const locked = lock.packages[`node_modules/${entry.name}`];
    assert.equal(locked.version, entry.version, entry.name);
    assert.ok(
      locked.resolved.startsWith("https://registry.npmjs.org/"),
      entry.name,
    );
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(locked.integrity, entry.integrity, entry.name);
    const installed = readJson(`node_modules/${entry.name}/package.json`);
    assert.equal(installed.name, entry.name);
    assert.equal(installed.version, entry.version, entry.name);
  }
});
