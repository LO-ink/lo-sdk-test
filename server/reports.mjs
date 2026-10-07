import { randomBytes } from "node:crypto";

const reportFields = [
  "createdAt",
  "appVersion",
  "bridgeCoverage",
  "adapter",
  "capabilities",
  "results",
  "events",
  "log",
  "automatedRun",
  "sdkBuild",
];
const maxDepth = 32;
const maxNodes = 50_000;
const maxBytes = 512 << 10;
const retainedBytes = 4 << 20;

export class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateComplexity(report) {
  const pending = [{ value: report, depth: 0 }];
  let nodes = 1;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (depth > maxDepth) throw new ReportError(413, "Отчёт слишком сложный");
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) {
        if (++nodes > maxNodes)
          throw new ReportError(413, "Отчёт слишком сложный");
        pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

export function serializeReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report))
    throw new ReportError(400, "Ожидается отчёт проверки");
  validateComplexity(report);
  const selected = Object.fromEntries(
    reportFields
      .filter((key) => Object.hasOwn(report, key))
      .map((key) => [key, report[key]]),
  );
  const data = JSON.stringify(selected, (key, value) =>
    /token|hash|signature|initdata|queryid/i.test(key) ? "[скрыто]" : value,
  );
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > maxBytes) throw new ReportError(413, "Отчёт слишком большой");
  return { data, bytes };
}

export function retainReport(reports, current, report, now) {
  const serialized = serializeReport(report);
  for (const [path, value] of reports)
    if (value.expires <= now) reports.delete(path);
  let bytes = serialized.bytes;
  let count = 1;
  for (const [path, value] of reports) {
    if (path === current.reportPath) continue;
    bytes += Buffer.byteLength(value.data, "utf8");
    count++;
  }
  if (count > 32 || bytes > retainedBytes)
    throw new ReportError(429, "Дождитесь завершения сохранения отчётов");
  // Keep the previous download usable until the replacement has been accepted.
  const path = `/reports/${randomBytes(24).toString("base64url")}.json`;
  if (current.reportPath) reports.delete(current.reportPath);
  reports.set(path, { ...serialized, expires: now + 60 });
  current.reportPath = path;
  return path;
}
