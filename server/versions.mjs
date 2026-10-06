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
      trees = new Map();
    const treeAt = (repository, commit) => {
      const key = `${repository}/${commit}`;
      if (!trees.has(key))
        trees.set(key, get(`${repository}/git/trees/${commit}?recursive=1`));
      return trees.get(key);
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
