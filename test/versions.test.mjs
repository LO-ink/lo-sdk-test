import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createVersionChecker } from "../server/versions.mjs";
import { createHandler } from "../server/app.mjs";
const source = "a".repeat(40),
  latest = "b".repeat(40);
const item = (name, repository = "lo-platform-adapters") => ({
  name:
    repository === "lo-bot-sdk"
      ? "@lo-ink/bot-sdk"
      : name === "two"
        ? "@lo-ink/bot-http-lo"
        : "@lo-ink/adapter-webapp-compat",
  repository,
  version: "0.3.0",
  sourceCommit: source,
});
const tree = (changed = false) => ({
  truncated: false,
  tree: [
    {
      path: "packages/compat",
      type: "tree",
      mode: "040000",
      sha: changed ? latest : source,
    },
    {
      path: "packages/bot-http-lo",
      type: "tree",
      mode: "040000",
      sha: changed ? latest : source,
    },
  ],
});
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("version check shares repo lookups, concurrent requests and cache; expired cache rechecks", async () => {
  let count = 0,
    clock = 0;
  const check = createVersionChecker({
    loadBuild: async () => ({
      packages: [item("one"), item("two"), item("three", "lo-bot-sdk")],
    }),
    now: () => clock,
    fetch: async (url, options) => {
      count++;
      assert.match(url, /^https:\/\/api\.github\.com\/repos\/LO-ink\//);
      assert.equal(options.headers.authorization, undefined);
      return response({ sha: source });
    },
  });
  const [first, second] = await Promise.all([check(), check()]);
  assert.deepEqual(first, second);
  assert.equal(count, 2);
  assert.equal(
    first.packages.every((p) => p.state === "current"),
    true,
  );
  clock = 599999;
  await check();
  assert.equal(count, 2);
  clock = 600000;
  const fresh = await check();
  assert.equal(count, 4);
  assert.notEqual(fresh.checkedAt, first.checkedAt);
});

test("direction of Git history determines update, ahead or unknown rather than trusting differing SHAs", async () => {
  for (const [direction, expected] of [
    ["ahead", "update"],
    ["behind", "ahead"],
    ["diverged", "unknown"],
  ]) {
    let comparisons = 0;
    const check = createVersionChecker({
      loadBuild: async () => ({ packages: [item("one"), item("two")] }),
      fetch: async (url) => {
        if (url.includes("/compare/")) {
          comparisons++;
          return response({ status: direction });
        }
        if (url.includes("/git/trees/"))
          return response(tree(url.includes(latest)));
        return response({ sha: latest });
      },
    });
    const result = await check();
    assert.equal(
      result.packages.every((p) => p.state === expected),
      true,
    );
    assert.equal(comparisons, 1);
  }
});

test("unrelated monorepo changes do not mark unchanged package trees as updates", async () => {
  const urls = [];
  const check = createVersionChecker({
    loadBuild: async () => ({ packages: [item("one"), item("two")] }),
    fetch: async (url) => {
      urls.push(url);
      if (url.includes("/git/trees/")) {
        const body = tree();
        body.tree.push({
          path: "packages/lo",
          type: "tree",
          mode: "040000",
          sha: url.includes(latest) ? latest : source,
        });
        return response(body);
      }
      assert.equal(
        url.includes("/compare/"),
        false,
        "identical package content needs no history comparison",
      );
      return response({ sha: latest });
    },
  });
  const result = await check();
  assert.deepEqual(
    result.packages.map((p) => p.state),
    ["current", "current"],
  );
  assert.equal(result.comparison, "package-sources");
  assert.deepEqual(
    result.packages.map((p) => p.comparedPaths),
    [["packages/compat"], ["packages/bot-http-lo"]],
  );
  assert.equal(
    urls.length,
    3,
    "one head and two shared recursive tree requests",
  );
});

test("same-version source edits update only the changed package, not its monorepo sibling", async () => {
  const check = createVersionChecker({
    loadBuild: async () => ({ packages: [item("one"), item("two")] }),
    fetch: async (url) => {
      if (url.includes("/git/trees/")) {
        const body = tree();
        if (url.includes(latest)) body.tree[0].sha = latest;
        return response(body);
      }
      return response(
        url.includes("/compare/") ? { status: "ahead" } : { sha: latest },
      );
    },
  });
  const result = await check();
  assert.deepEqual(
    result.packages.map((p) => p.state),
    ["update", "current"],
  );
  assert.equal(
    result.packages[0].version,
    "0.3.0",
    "matching version strings cannot conceal changed source",
  );
});

test("JS SDK freshness excludes sibling Go source but includes build inputs and package metadata", async () => {
  for (const changedPath of [
    "go",
    "src",
    "scripts/build.mjs",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]) {
    const check = createVersionChecker({
      loadBuild: async () => ({
        packages: [
          {
            ...item("one"),
            name: "@lo-ink/miniapp-sdk",
            repository: "lo-miniapp-sdk",
          },
        ],
      }),
      fetch: async (url) => {
        if (url.includes("/git/trees/"))
          return response({
            truncated: false,
            tree: [
              "src",
              "scripts/build.mjs",
              "package.json",
              "package-lock.json",
              "tsconfig.json",
              "README.md",
              "LICENSE",
              "CHANGELOG.md",
              "go",
            ].map((path) => ({
              path,
              type: ["src", "go"].includes(path) ? "tree" : "blob",
              mode: "100644",
              sha:
                path === changedPath && url.includes(latest) ? latest : source,
            })),
          });
        return response(
          url.includes("/compare/") ? { status: "ahead" } : { sha: latest },
        );
      },
    });
    assert.equal(
      (await check()).packages[0].state,
      changedPath === "go" ? "current" : "update",
      changedPath,
    );
  }
});

test("incomplete package trees and contradictory history remain unverified", async () => {
  for (const badTree of [
    { ...tree(), truncated: true },
    { tree: tree().tree },
    { truncated: false, tree: [] },
    { truncated: false, tree: [{ ...tree().tree[0], sha: "bad" }] },
    { truncated: false, tree: [tree().tree[0], tree().tree[0]] },
    tree(true),
  ]) {
    const check = createVersionChecker({
      loadBuild: async () => ({ packages: [item("one")] }),
      fetch: async (url) => {
        if (url.includes("/git/trees/"))
          return response(url.includes(latest) ? badTree : tree());
        return response(
          url.includes("/compare/") ? { status: "identical" } : { sha: latest },
        );
      },
    });
    assert.equal((await check()).packages[0].state, "unknown");
  }
});

test("GitHub failure and invalid metadata are unverified; errors do not hide healthy repos or hammer the API", async () => {
  let clock = 0,
    count = 0;
  const check = createVersionChecker({
    loadBuild: async () => ({
      packages: [
        item("ok", "lo-bot-sdk"),
        item("rate-limit"),
        item("invalid", "foreign-repo"),
      ],
    }),
    now: () => clock,
    fetch: async (url) => {
      count++;
      return url.includes("lo-bot-sdk")
        ? response({ sha: source })
        : response({}, 429);
    },
  });
  const first = await check();
  assert.deepEqual(
    first.packages.map((p) => p.state),
    ["current", "unknown", "unknown"],
  );
  await check();
  assert.equal(count, 2);
  clock = 60000;
  await check();
  assert.equal(count, 4);
  const malformed = createVersionChecker({
    loadBuild: async () => ({ packages: [item("one")] }),
    fetch: async () => response({ sha: "not-a-commit" }),
  });
  assert.equal((await malformed()).packages[0].state, "unknown");
});

test("public version endpoint returns checker metadata without requiring LO login or revealing credentials", async (t) => {
  const metadata = {
    basis: "github-main",
    checkedAt: new Date(0).toISOString(),
    packages: [{ ...item("one"), state: "current" }],
  };
  const server = createServer(
    createHandler(
      {
        LO_APP_ID: "private-app",
        LO_APP_KEY: "private-key",
        LO_BOT_TOKEN: "private-token",
      },
      { checkVersions: async () => metadata },
    ),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await fetch(
    `http://127.0.0.1:${server.address().port}/api/sdk-versions`,
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  const body = await result.text();
  assert.equal(body.includes("private-"), false);
  assert.deepEqual(JSON.parse(body), metadata);
});
