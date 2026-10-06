import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const revision = process.env.BUILD_REVISION ?? "local";
if (revision !== "local" && !/^[a-f0-9]{40}$/.test(revision))
  throw new Error("BUILD_REVISION must be a full Git commit");
writeFileSync(
  "dist/release.json",
  JSON.stringify({ version, revision }) + "\n",
);

copyFileSync("sdk-build.json", "dist/sdk-build.json");
