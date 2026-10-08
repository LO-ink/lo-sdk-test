import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createVersionChecker } from "../server/versions.mjs";
import { createHandler } from "../server/app.mjs";
const source = "a".repeat(40),
  latest = "b".repeat(40);
const item = (name, repository = "lo-ui") => ({
  name:
    repository === "lo-bot-sdk"
      ? "@lo-ink/bot-sdk"
      : name === "two"
        ? "@lo-ink/ui"
        : "@lo-ink/design-tokens",
  repository,
  version: "0.3.0",
  sourceCommit: source,
});
const sharedBuildPaths = [
  "scripts/build-package.mjs",
  "package.json",
  "package-lock.json",
];
const tree = (changed = false) => ({
  truncated: false,
  tree: [
    {
      path: "packages/design-tokens",
      type: "tree",
      mode: "040000",
      sha: changed ? latest : source,
    },
    {
      path: "packages/ui",
      type: "tree",
      mode: "040000",
      sha: changed ? latest : source,
    },
    ...["LICENSE", ...sharedBuildPaths].map((path) => ({
      path,
      type: "blob",
      mode: "100644",
      sha: source,
    })),
  ],
});
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const workspaceLock = () => ({
  name: "workspace",
  lockfileVersion: 3,
  packages: {
    "": {
      workspaces: ["packages/*", "apps/*"],
      devDependencies: { typescript: "5.9.3" },
    },
    "packages/ui": {
      name: "@lo-ink/ui",
      version: "0.3.1",
      dependencies: { "@lo-ink/design-tokens": "0.3.1" },
    },
    "packages/design-tokens": {
      name: "@lo-ink/design-tokens",
      version: "0.3.1",
    },
    "apps/gallery": {
      name: "gallery",
      version: "0.1.0",
      dependencies: { "@lo-ink/ui": "0.3.1" },
    },
    "node_modules/@lo-ink/ui": { resolved: "packages/ui", link: true },
    "node_modules/@lo-ink/design-tokens": {
      resolved: "packages/design-tokens",
      link: true,
    },
    "node_modules/gallery": { resolved: "apps/gallery", link: true },
    "node_modules/typescript": {
      version: "5.9.3",
      integrity: "sha512-compiler",
    },
  },
});
const lockBlob = (lock, id) => {
  const content = JSON.stringify(lock);
  return {
    sha: id,
    encoding: "base64",
    size: Buffer.byteLength(content),
    content: Buffer.from(content).toString("base64"),
  };
};
const compilerBlob = (url) => {
  const lock = workspaceLock();
  if (url.endsWith(latest))
    lock.packages["node_modules/typescript"].version = "6.0.0";
  return response(lockBlob(lock, url.endsWith(latest) ? latest : source));
};

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
          path: "apps/gallery",
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
    [
      ["packages/design-tokens", "LICENSE", ...sharedBuildPaths],
      ["packages/ui", "LICENSE", ...sharedBuildPaths],
    ],
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

test("JS SDK freshness excludes Go and workflow edits but includes current build inputs and package metadata", async () => {
  for (const changedPath of [
    "go",
    ".github/workflows/ci.yml",
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
              "go",
              ".github/workflows/ci.yml",
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
      ["go", ".github/workflows/ci.yml"].includes(changedPath)
        ? "current"
        : "update",
      changedPath,
    );
  }
});

test("monorepo compiler and clean-build changes invalidate both dependent package scopes", async () => {
  for (const changedPath of ["LICENSE", ...sharedBuildPaths]) {
    const check = createVersionChecker({
      loadBuild: async () => ({ packages: [item("one"), item("two")] }),
      fetch: async (url) => {
        if (url.includes("/git/blobs/")) return compilerBlob(url);
        if (url.includes("/git/trees/")) {
          const body = tree();
          if (url.includes(latest))
            body.tree.find((entry) => entry.path === changedPath).sha = latest;
          return response(body);
        }
        return response(
          url.includes("/compare/") ? { status: "ahead" } : { sha: latest },
        );
      },
    });
    assert.deepEqual(
      (await check()).packages.map((entry) => entry.state),
      ["update", "update"],
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

test("UI freshness checks its package and shared build config independently of its sibling", async () => {
  for (const changedPath of [
    "packages/ui",
    "packages/design-tokens",
    "LICENSE",
    "package.json",
    "package-lock.json",
    "scripts/build-package.mjs",
    ".github/workflows/ci.yml",
  ]) {
    const check = createVersionChecker({
      loadBuild: async () => ({
        packages: ["ui", "design-tokens"].map((name) => ({
          name: `@lo-ink/${name}`,
          repository: "lo-ui",
          version: "0.1.0",
          sourceCommit: source,
        })),
      }),
      fetch: async (url) => {
        if (url.includes("/git/blobs/")) return compilerBlob(url);
        if (url.includes("/git/trees/"))
          return response({
            truncated: false,
            tree: [
              "packages/ui",
              "packages/design-tokens",
              "LICENSE",
              "package.json",
              "package-lock.json",
              "scripts/build-package.mjs",
              ".github/workflows/ci.yml",
            ].map((path) => ({
              path,
              type: path.startsWith("packages/") ? "tree" : "blob",
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
    assert.deepEqual(
      (await check()).packages.map((p) => p.state),
      changedPath === "packages/ui"
        ? ["update", "current"]
        : changedPath === "packages/design-tokens"
          ? ["current", "update"]
          : ["LICENSE", ...sharedBuildPaths].includes(changedPath)
            ? ["update", "update"]
            : ["current", "current"],
    );
  }
});

test("workspace lock comparison ignores only unrelated local records and retains all build inputs", async () => {
  const scenarios = [
    [
      "sibling UI and gallery versions",
      (lock) => {
        lock.packages["packages/ui"].version = "0.4.0";
        lock.packages["apps/gallery"].dependencies["@lo-ink/ui"] = "0.4.0";
      },
      "current",
    ],
    [
      "sibling new local link",
      (lock) => {
        lock.packages["apps/preview"] = { name: "preview", version: "1.0.0" };
        lock.packages["node_modules/preview"] = {
          resolved: "apps/preview",
          link: true,
        };
      },
      "current",
    ],
    [
      "target version",
      (lock) => {
        lock.packages["packages/design-tokens"].version = "0.3.2";
      },
      "update",
    ],
    [
      "compiler version",
      (lock) => {
        lock.packages["node_modules/typescript"].version = "6.0.0";
      },
      "update",
    ],
    [
      "compiler integrity",
      (lock) => {
        lock.packages["node_modules/typescript"].integrity = "sha512-other";
      },
      "update",
    ],
    [
      "root build dependency",
      (lock) => {
        lock.packages[""].devDependencies.typescript = "6.0.0";
      },
      "update",
    ],
    [
      "sibling nested external dependency",
      (lock) => {
        lock.packages["apps/gallery/node_modules/external"] = {
          version: "1.0.0",
          integrity: "sha512-external",
        };
      },
      "update",
    ],
    [
      "malformed lock",
      (lock) => {
        lock.packages = [];
      },
      "unknown",
    ],
    [
      "unsupported lock version",
      (lock) => {
        lock.lockfileVersion = 2;
      },
      "unknown",
    ],
    [
      "missing target",
      (lock) => {
        delete lock.packages["packages/design-tokens"];
      },
      "unknown",
    ],
    [
      "broken link",
      (lock) => {
        lock.packages["node_modules/@lo-ink/ui"].resolved = "outside";
      },
      "unknown",
    ],
    [
      "malformed local dependency",
      (lock) => {
        lock.packages["packages/ui"].dependencies = [];
      },
      "unknown",
    ],
    [
      "missing external version",
      (lock) => {
        delete lock.packages["node_modules/typescript"].version;
      },
      "unknown",
    ],
    [
      "undeclared workspace",
      (lock) => {
        lock.packages[""].workspaces = ["packages/*"];
      },
      "unknown",
    ],
    [
      "root local build dependency",
      (lock) => {
        lock.packages[""].devDependencies["@lo-ink/ui"] = "0.3.1";
      },
      "update",
    ],
    [
      "record ordering",
      (lock) => {
        lock.packages = Object.fromEntries(
          Object.entries(lock.packages).reverse(),
        );
      },
      "current",
    ],
  ];
  for (const [label, mutate, expected] of scenarios) {
    const after = workspaceLock();
    mutate(after);
    let blobs = 0;
    const check = createVersionChecker({
      loadBuild: async () => ({
        packages: [
          {
            name: "@lo-ink/design-tokens",
            repository: "lo-ui",
            version: "0.3.1",
            sourceCommit: source,
          },
        ],
      }),
      fetch: async (url) => {
        if (url.includes("/git/trees/"))
          return response({
            truncated: false,
            tree: [
              "packages/design-tokens",
              "LICENSE",
              ...sharedBuildPaths,
            ].map((path) => ({
              path,
              type: path.startsWith("packages/") ? "tree" : "blob",
              mode: path.startsWith("packages/") ? "040000" : "100644",
              sha:
                path === "package-lock.json" && url.includes(latest)
                  ? latest
                  : source,
            })),
          });
        if (url.includes("/git/blobs/")) {
          blobs++;
          return response(
            lockBlob(
              url.endsWith(latest) ? after : workspaceLock(),
              url.endsWith(latest) ? latest : source,
            ),
          );
        }
        return response(
          url.includes("/compare/") ? { status: "ahead" } : { sha: latest },
        );
      },
    });
    assert.equal((await check()).packages[0].state, expected, label);
    assert.equal(blobs, 2, label);
  }
});

test("malformed Git lock blobs fail closed instead of claiming package freshness", async () => {
  for (const mutate of [
    (blob) => {
      blob.encoding = "utf8";
    },
    (blob) => {
      blob.sha = "c".repeat(40);
    },
    (blob) => {
      blob.size++;
    },
    (blob) => {
      blob.content += "!";
    },
    (blob) => {
      blob.content = Buffer.from("{").toString("base64");
      blob.size = 1;
    },
  ]) {
    const check = createVersionChecker({
      loadBuild: async () => ({ packages: [item("one")] }),
      fetch: async (url) => {
        if (url.includes("/git/trees/")) {
          const result = tree();
          if (url.includes(latest))
            result.tree.find(
              (entry) => entry.path === "package-lock.json",
            ).sha = latest;
          return response(result);
        }
        if (url.includes("/git/blobs/")) {
          const blob = lockBlob(
            workspaceLock(),
            url.endsWith(latest) ? latest : source,
          );
          if (url.endsWith(latest)) mutate(blob);
          return response(blob);
        }
        assert.equal(url.includes("/compare/"), false);
        return response({ sha: latest });
      },
    });
    assert.equal((await check()).packages[0].state, "unknown");
  }
});

test("workspace dependency closure includes transitive local build inputs and shared blob requests", async () => {
  const before = workspaceLock();
  // Test-only private build input: UI -> tokens -> build-support, without a cycle.
  before.packages["packages/design-tokens"].devDependencies = {
    "@fixture/build-support": "1.0.0",
  };
  before.packages["packages/build-support"] = {
    name: "@fixture/build-support",
    version: "1.0.0",
  };
  before.packages["node_modules/@fixture/build-support"] = {
    resolved: "packages/build-support",
    link: true,
  };
  const after = structuredClone(before);
  after.packages["packages/build-support"].version = "1.0.1";
  let blobs = 0;
  const check = createVersionChecker({
    loadBuild: async () => ({ packages: [item("one"), item("two")] }),
    fetch: async (url) => {
      if (url.includes("/git/trees/")) {
        const result = tree();
        if (url.includes(latest))
          result.tree.find((entry) => entry.path === "package-lock.json").sha =
            latest;
        return response(result);
      }
      if (url.includes("/git/blobs/")) {
        blobs++;
        return response(
          lockBlob(
            url.endsWith(latest) ? after : before,
            url.endsWith(latest) ? latest : source,
          ),
        );
      }
      return response(
        url.includes("/compare/") ? { status: "ahead" } : { sha: latest },
      );
    },
  });
  assert.deepEqual(
    (await check()).packages.map((p) => p.state),
    ["update", "update"],
  );
  assert.equal(blobs, 2);
});

test("current shipped receipt supports exactly its four SDK scopes; unconfigured metadata makes no request", async () => {
  const build = JSON.parse(
    readFileSync(new URL("../sdk-build.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(build.packages.map((p) => p.name).sort(), [
    "@lo-ink/bot-sdk",
    "@lo-ink/design-tokens",
    "@lo-ink/miniapp-sdk",
    "@lo-ink/ui",
  ]);
  const urls = [];
  const check = createVersionChecker({
    loadBuild: async () => ({
      packages: build.packages.map((p) => ({ ...p, sourceCommit: source })),
    }),
    fetch: async (url) => {
      urls.push(url);
      return response({ sha: source });
    },
  });
  assert.deepEqual(
    (await check()).packages.map((p) => p.state),
    ["current", "current", "current", "current"],
  );
  assert.deepEqual(
    urls.sort(),
    ["lo-bot-sdk", "lo-miniapp-sdk", "lo-ui"].map(
      (repo) => `https://api.github.com/repos/LO-ink/${repo}/commits/main`,
    ),
  );
  let unconfiguredRequests = 0;
  const unknown = createVersionChecker({
    loadBuild: async () => ({
      packages: [
        { ...item("one"), name: "@fixture/unconfigured" },
        item("one", "foreign-repo"),
      ],
    }),
    fetch: async () => {
      unconfiguredRequests++;
      return response({ sha: source });
    },
  });
  assert.deepEqual(
    (await unknown()).packages.map((p) => p.state),
    ["unknown", "unknown"],
  );
  assert.equal(unconfiguredRequests, 0);
});
