import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { InitDataError } from "@lo-ink/miniapp-sdk/server";

const codes = new Set([
  "invalid-data",
  "invalid-signature",
  "wrong-app-id",
  "expired",
  "future-auth-date",
  "duplicate-parameter",
]);

export class GoVerifierUnavailable extends Error {
  constructor() {
    super("Go initData verifier unavailable");
  }
}

export function createGoVerifier({
  binary = fileURLToPath(
    new URL(
      `./go/bin/initdata-${process.platform}-${{ x64: "amd64", arm64: "arm64" }[process.arch]}`,
      import.meta.url,
    ),
  ),
  args = [],
  timeoutMs = 3000,
} = {}) {
  accessSync(binary, constants.X_OK);
  return (raw, options) =>
    new Promise((resolve, reject) => {
      const input = JSON.stringify({ raw, ...options });
      if (Buffer.byteLength(input) > 80000)
        return reject(new InitDataError("invalid-data"));
      const child = spawn(binary, args, {
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
        signal: AbortSignal.timeout(timeoutMs),
      });
      let output = "";
      let bytes = 0;
      let failed = false;
      const fail = () => {
        failed = true;
        reject(new GoVerifierUnavailable());
      };
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 4096) {
          fail();
          child.kill();
          return;
        }
        output += chunk.toString("utf8");
      });
      child.on("close", (code) => {
        if (failed) return;
        if (code !== 0) return fail();
        try {
          const result = JSON.parse(output);
          if (result?.verified === false && codes.has(result.code)) {
            reject(new InitDataError(result.code));
            return;
          }
          if (
            result?.verified !== true ||
            typeof result.userId !== "string" ||
            typeof result.appId !== "string" ||
            !Number.isSafeInteger(result.authDate)
          )
            return fail();
          resolve(result);
        } catch {
          fail();
        }
      });
      child.stdin.end(input);
    });
}
