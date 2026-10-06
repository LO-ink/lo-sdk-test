import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cases, events } from "../web/cases.ts";
test("every public SDK operation has a typed test case", () => {
  const protocol = readFileSync(
    new URL(
      "../node_modules/@lo-ink/miniapp-sdk/dist/protocol.d.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const operations = [
    ...protocol
      .split("export type MiniAppOperationMap = {")[1]
      .split("export type MiniAppOperation =")[0]
      .matchAll(/^ {4}([A-Za-z]+):/gm),
  ].map((match) => match[1]);
  assert.equal(operations.length > 50, true);
  assert.deepEqual(Object.keys(cases).sort(), operations.sort());
  const eventBlock = protocol
    .split("export type MiniAppEventMap = {")[1]
    .split("export type MiniAppEvent =")[0];
  const eventNames = [...eventBlock.matchAll(/^ {4}([A-Za-z]+):/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual([...events].sort(), eventNames.sort());
});
