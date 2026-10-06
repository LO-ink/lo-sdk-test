import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../server/go/", import.meta.url));
const provenance = JSON.parse(
  readFileSync(join(root, "sdk-provenance.json"), "utf8"),
);
function sourceFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (entry.isDirectory())
      return sourceFiles(join(directory, entry.name), path + "/");
    if (!entry.isFile()) throw new Error("Unexpected Go SDK source entry");
    return [path];
  });
}
const actualPaths = sourceFiles(join(root, "sdk")).sort();
if (
  JSON.stringify(actualPaths) !==
  JSON.stringify(Object.keys(provenance.files).sort())
)
  throw new Error("Go SDK source inventory changed");
for (const [path, expected] of Object.entries(provenance.files)) {
  const actual = createHash("sha256")
    .update(readFileSync(join(root, "sdk", path)))
    .digest("hex");
  if (actual !== expected) throw new Error(`Go SDK source changed: ${path}`);
}
const architecture = { x64: "amd64", arm64: "arm64" }[process.arch];
if (!architecture || !["darwin", "linux"].includes(process.platform))
  throw new Error("Unsupported verifier build platform");
const targets = new Set([`${process.platform}-${architecture}`]);
if (process.argv.includes("--release")) {
  targets.add("linux-amd64");
  targets.add("linux-arm64");
}
const directory = join(root, "bin");
mkdirSync(directory, { recursive: true });
for (const target of targets) {
  const [GOOS, GOARCH] = target.split("-");
  const binary = join(directory, `initdata-${target}`);
  execFileSync(
    "go",
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags=-s -w",
      "-o",
      binary,
      ".",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GOTOOLCHAIN: "go1.27.1",
        CGO_ENABLED: "0",
        GOOS,
        GOARCH,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  chmodSync(binary, 0o755);
}
console.log(
  `Go initData verifier built from ${provenance.sourceCommit.slice(0, 7)} (${targets.size} targets).`,
);
