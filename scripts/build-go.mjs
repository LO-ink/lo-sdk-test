import { execFileSync } from "node:child_process";
import { mkdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../server/go/", import.meta.url));
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
      "-mod=readonly",
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
  `Go initData verifier built from the pinned module (${targets.size} targets).`,
);
