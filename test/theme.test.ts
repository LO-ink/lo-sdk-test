import assert from "node:assert/strict";
import test from "node:test";
import { applyPalette, palette } from "../web/theme.ts";

test("native themes use current screen surfaces and accessible web control roles", () => {
  assert.equal(palette("lo", "light")["--page"], "#F7FBFF");
  const dark = palette("lo", "dark");
  assert.equal(dark["--page"], "#0B0E17");
  assert.equal(dark["--surface"], "#111522");
  assert.equal(dark["--ink"], "#F7FBFF");
  assert.equal(dark["--accent"], "#5969FC");
  assert.equal(dark["--accent-fill"], "#5060E8");
  assert.equal(dark["--accent-text"], "#91A2FF");
  assert.equal(
    palette("lo", "light", {
      button_color: "#5969fc",
      button_text_color: "#f7fbff",
    })["--accent-fill"],
    "#5060E8",
  );
});
test("host theme colors reach canvas and all action roles, while invalid colors cannot become CSS", () => {
  const params = {
    bg_color: "#123456",
    secondary_bg_color: "#234567",
    text_color: "#abcdef",
    button_color: "#006644",
    button_text_color: "#FFFFFF",
    link_color: "#225599",
  };
  const values = new Map<string, string>();
  applyPalette(
    {
      style: {
        setProperty: (key, value) => {
          values.set(key, value);
        },
      },
    },
    "lo",
    "light",
    params,
  );
  assert.equal(values.get("--page"), params.bg_color);
  assert.equal(values.get("--surface"), params.secondary_bg_color);
  assert.equal(values.get("--ink"), params.text_color);
  assert.equal(values.get("--accent"), params.button_color);
  assert.equal(values.get("--accent-fill"), params.button_color);
  assert.equal(values.get("--accent-ink"), params.button_text_color);
  assert.equal(values.get("--accent-text"), params.link_color);
  assert.equal(
    palette("lo", "light", {
      button_color: "var(--unsafe)",
      bg_color: "url(unsafe)",
    })["--page"],
    "#F7FBFF",
  );
  const compat = palette("telegram", "light", params);
  assert.equal(compat["--page"], params.secondary_bg_color);
  assert.equal(compat["--surface"], params.bg_color);
});
