import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import postcss from "postcss";

const typography = new Set([
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "color",
  "accent-color",
  "appearance",
  "-webkit-appearance",
]);
export function uiBoundaryFailures(css, file = "application.css") {
  const failures = [];
  const root = postcss.parse(css, { from: file });
  root.walkDecls((declaration) => {
    if (typography.has(declaration.prop.toLowerCase()))
      failures.push(
        `${file}:${declaration.source.start.line}: use SDK typography and control styles for ${declaration.prop}`,
      );
  });
  root.walkRules((rule) => {
    if (/\.lo-ui-[a-z-]+/.test(rule.selector))
      failures.push(
        `${file}:${rule.source.start.line}: shared UI selectors belong to the SDK`,
      );
  });
  return failures;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const failures = uiBoundaryFailures(
    readFileSync(new URL("../web/style.css", import.meta.url), "utf8"),
    "web/style.css",
  );
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log("Application CSS uses the shared UI boundary.");
}
