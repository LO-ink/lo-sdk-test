import test from "node:test";
import assert from "node:assert/strict";
import { uiBoundaryFailures } from "../scripts/check-ui-boundary.mjs";

test("UI boundary rejects type/control styles and SDK selector overrides", () => {
  for (const css of [
    ".page { font-size: 20px }",
    ".page { color: red }",
    ".lo-ui-button { background: red }",
  ])
    assert.equal(uiBoundaryFailures(css).length, 1, css);
});

test("UI boundary permits layout, host tokens and tabular report numbers", () => {
  assert.deepEqual(
    uiBoundaryFailures(
      "/* .lo-ui-button { color: red } */ .interaction-input { display: grid; gap: 16px; --lo-color-canvas: #f7fbff; font-variant-numeric: tabular-nums }",
    ),
    [],
  );
});
