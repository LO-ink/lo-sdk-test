// Source scopes include package content and its build inputs, not sibling SDKs
// or repository-wide workflow history. New packages require an explicit scope.
const rootPackagePaths = [
  "src",
  "scripts/build.mjs",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "README.md",
  "LICENSE",
];
const monorepoBuildPaths = [
  "scripts/build-package.mjs",
  "package.json",
  "package-lock.json",
];
const packageSources = new Map([
  ["@lo-ink/miniapp-sdk", ["lo-miniapp-sdk", rootPackagePaths]],
  ["@lo-ink/bot-sdk", ["lo-bot-sdk", rootPackagePaths]],
  [
    "@lo-ink/adapter-lo-legacy",
    ["lo-platform-adapters", ["packages/lo-legacy", ...monorepoBuildPaths]],
  ],
  [
    "@lo-ink/adapter-webapp-compat",
    ["lo-platform-adapters", ["packages/compat", ...monorepoBuildPaths]],
  ],
  ["@lo-ink/ui", ["lo-ui", ["packages/ui", "LICENSE", ...monorepoBuildPaths]]],
  [
    "@lo-ink/design-tokens",
    ["lo-ui", ["packages/design-tokens", "LICENSE", ...monorepoBuildPaths]],
  ],
]);
const sha = /^[a-f0-9]{40}$/;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (record(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
function scopedLock(lock, target, name) {
  if (
    !record(lock) ||
    lock.lockfileVersion !== 3 ||
    !record(lock.packages) ||
    !record(lock.packages[""]) ||
    !Array.isArray(lock.packages[""].workspaces) ||
    !lock.packages[""].workspaces.length ||
    !lock.packages[""].workspaces.every(
      (path) =>
        typeof path === "string" && /^(packages|apps)\/(\*|[^/*]+)$/.test(path),
    )
  )
    throw new Error("Unsupported workspace lock");
  const locals = new Map(),
    names = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!record(entry)) throw new Error("Invalid locked package");
    if (
      path &&
      entry.link !== true &&
      (typeof entry.version !== "string" || !entry.version)
    )
      throw new Error("Missing locked version");
    for (const field of dependencyFields) {
      if (
        entry[field] !== undefined &&
        (!record(entry[field]) ||
          !Object.values(entry[field]).every(
            (value) => typeof value === "string",
          ))
      )
        throw new Error("Invalid locked dependencies");
    }
    if (path && !path.split("/").includes("node_modules")) {
      if (
        !/^(packages|apps)\/[^/]+$/.test(path) ||
        !lock.packages[""].workspaces.some((pattern) =>
          pattern.endsWith("/*")
            ? path.startsWith(pattern.slice(0, -1))
            : path === pattern,
        ) ||
        typeof entry.name !== "string" ||
        !entry.name ||
        names.has(entry.name) ||
        entry.link !== undefined
      )
        throw new Error("Invalid workspace package");
      locals.set(path, entry);
      names.set(entry.name, path);
    }
  }
  if (locals.get(target)?.name !== name)
    throw new Error("Missing target workspace");
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (
      entry.link !== undefined &&
      (entry.link !== true ||
        !path.split("/").includes("node_modules") ||
        !locals.has(entry.resolved))
    )
      throw new Error("Invalid workspace link");
  }
  const selected = new Set([target]);
  const queue = [lock.packages[""], locals.get(target)];
  for (const entry of queue) {
    for (const field of dependencyFields) {
      for (const dependency of Object.keys(entry[field] ?? {})) {
        const path = names.get(dependency);
        if (path && !selected.has(path)) {
          selected.add(path);
          queue.push(locals.get(path));
        }
      }
    }
  }
  // Keep every external resolution, integrity and root build dependency. Only
  // proven unrelated local workspace records and their links are irrelevant.
  const packages = Object.fromEntries(
    Object.entries(lock.packages).filter(
      ([path, entry]) =>
        (!locals.has(path) || selected.has(path)) &&
        (entry.link !== true || selected.has(entry.resolved)),
    ),
  );
  return JSON.stringify(stable({ ...lock, packages }));
}

// Public GitHub metadata only. No LO or GitHub credentials are sent.
export function createVersionChecker({
  loadBuild,
  fetch: request = fetch,
  now = Date.now,
  timeoutMs = 5000,
} = {}) {
  let cached,
    expires = 0,
    pending;
  const get = async (path) => {
    const response = await request(
      `https://api.github.com/repos/LO-ink/${path}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "LO-SDK-Test",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) throw new Error("GitHub unavailable");
    return response.json();
  };
  function fingerprint(tree, paths) {
    // Never infer equality from a truncated listing, missing paths or malformed
    // entries. Tree IDs cover all nested files, including same-version edits.
    if (tree.truncated !== false || !Array.isArray(tree.tree))
      throw new Error("Incomplete Git tree");
    return paths
      .map((path) => {
        const entries = tree.tree.filter((entry) => entry.path === path);
        const entry = entries[0];
        if (
          entries.length !== 1 ||
          !sha.test(entry.sha) ||
          !["tree", "blob"].includes(entry.type)
        )
          throw new Error("Invalid package source");
        return `${entry.type}:${entry.mode}:${entry.sha}`;
      })
      .join(";");
  }
  async function check() {
    const build = await loadBuild();
    const heads = new Map(),
      comparisons = new Map(),
      trees = new Map(),
      blobs = new Map();
    const treeAt = (repository, commit) => {
      const key = `${repository}/${commit}`;
      if (!trees.has(key))
        trees.set(key, get(`${repository}/git/trees/${commit}?recursive=1`));
      return trees.get(key);
    };
    const lockAt = (repository, tree) => {
      const entry = tree.tree.find((item) => item.path === "package-lock.json");
      if (entry?.type !== "blob") throw new Error("Invalid lock blob");
      const key = `${repository}/${entry.sha}`;
      if (!blobs.has(key))
        blobs.set(
          key,
          get(`${repository}/git/blobs/${entry.sha}`).then((blob) => {
            if (
              blob.sha !== entry.sha ||
              blob.encoding !== "base64" ||
              typeof blob.content !== "string" ||
              !Number.isSafeInteger(blob.size) ||
              blob.size < 0 ||
              blob.size > 5 * 1024 * 1024
            )
              throw new Error("Invalid lock blob");
            const content = Buffer.from(blob.content, "base64");
            if (
              content.length !== blob.size ||
              content.toString("base64") !== blob.content.replace(/\s/g, "")
            )
              throw new Error("Incomplete lock blob");
            return JSON.parse(content.toString("utf8"));
          }),
        );
      return blobs.get(key);
    };
    const packages = await Promise.all(
      build.packages.map(async (p) => {
        const base = {
          name: p.name,
          version: p.version,
          sourceCommit: p.sourceCommit,
          state: "unknown",
        };
        const scope = packageSources.get(p.name);
        if (!scope || scope[0] !== p.repository || !sha.test(p.sourceCommit))
          return base;
        base.comparedPaths = scope[1];
        try {
          if (!heads.has(p.repository))
            heads.set(p.repository, get(`${p.repository}/commits/main`));
          const head = (await heads.get(p.repository)).sha;
          if (!sha.test(head)) return base;
          if (head === p.sourceCommit)
            return { ...base, state: "current", latestCommit: head };
          const [builtTree, latestTree] = await Promise.all([
            treeAt(p.repository, p.sourceCommit),
            treeAt(p.repository, head),
          ]);
          if (
            fingerprint(builtTree, scope[1]) ===
            fingerprint(latestTree, scope[1])
          )
            return { ...base, state: "current", latestCommit: head };
          const target = scope[1][0];
          const otherPaths = scope[1].filter(
            (path) => path !== "package-lock.json",
          );
          const builtLock = builtTree.tree.find(
            (entry) => entry.path === "package-lock.json",
          );
          const latestLock = latestTree.tree.find(
            (entry) => entry.path === "package-lock.json",
          );
          if (
            target.startsWith("packages/") &&
            builtLock.type === latestLock.type &&
            builtLock.mode === latestLock.mode &&
            fingerprint(builtTree, otherPaths) ===
              fingerprint(latestTree, otherPaths)
          ) {
            const [before, after] = await Promise.all([
              lockAt(p.repository, builtTree),
              lockAt(p.repository, latestTree),
            ]);
            if (
              scopedLock(before, target, p.name) ===
              scopedLock(after, target, p.name)
            )
              return { ...base, state: "current", latestCommit: head };
          }
          const key = `${p.repository}/${p.sourceCommit}...${head}`;
          if (!comparisons.has(key))
            comparisons.set(
              key,
              get(
                `${p.repository}/compare/${p.sourceCommit}...${head}?per_page=1`,
              ),
            );
          const compared = await comparisons.get(key);
          const state =
            compared.status === "ahead"
              ? "update"
              : compared.status === "behind"
                ? "ahead"
                : "unknown";
          return { ...base, state, latestCommit: head };
        } catch {
          return base;
        }
      }),
    );
    return {
      basis: "github-main",
      comparison: "package-sources",
      checkedAt: new Date(now()).toISOString(),
      packages,
    };
  }
  return async () => {
    if (cached && now() < expires) return cached;
    if (!pending)
      pending = check()
        .then((result) => {
          cached = result;
          expires =
            now() +
            (result.packages.some((p) => p.state === "unknown")
              ? 60000
              : 600000);
          return result;
        })
        .finally(() => {
          pending = undefined;
        });
    return pending;
  };
}
