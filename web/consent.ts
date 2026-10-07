import type { MiniAppClient } from "@lo-ink/miniapp-sdk";
import { bounded } from "./runner.ts";

export type WriteAccessResult = {
  allowed: boolean;
  error?: string;
  skipped?: boolean;
};

// Start inside the click handler so LO receives the user's gesture. Settle errors
// immediately; the suite consumes this result after verifying the launch data.
export function beginWriteAccess(
  client: MiniAppClient,
  signal: AbortSignal,
): Promise<WriteAccessResult> {
  let request: Promise<boolean>;
  try {
    signal.throwIfAborted();
    request = client.call("requestWriteAccess", undefined, {
      signal,
      timeoutMs: 60000,
    });
  } catch (error) {
    return Promise.resolve({
      allowed: false,
      error:
        error instanceof Error ? error.message : "LO не подтвердил разрешение",
    });
  }
  return bounded(() => request, signal, 60000).then(
    (allowed) => ({ allowed: allowed === true }),
    (error) => ({
      allowed: false,
      error:
        error instanceof Error ? error.message : "LO не подтвердил разрешение",
    }),
  );
}
