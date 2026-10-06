export type CheckState =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "manual"
  | "cancelled";
export type CheckResult = {
  id: string;
  label: string;
  group: string;
  state: CheckState;
  detail: string;
  durationMs: number;
  bridge?: string;
  evidence?: "response" | "data" | "device" | "synthetic";
};
export type CheckOutcome = {
  state: "passed" | "manual" | "skipped";
  detail: string;
  evidence?: CheckResult["evidence"];
};
export type RunReport = {
  id: string;
  owner?: { appId: string; userId: string };
  startedAt: string;
  finishedAt?: string;
  state: "running" | "finished" | "cancelled";
  checks: CheckResult[];
};
export type Check = Pick<CheckResult, "id" | "label" | "group"> & {
  bridge?: string;
  evidence?: CheckResult["evidence"];
  timeoutMs?: number;
  timeoutState?: "manual";
  skip?: () => { state: "skipped" | "manual"; detail: string } | undefined;
  execute: (signal: AbortSignal) => Promise<string | CheckOutcome>;
  // Runs outside the action timeout, before the next case, even after abort.
  finalize?: (signal: AbortSignal) => Promise<void>;
};
export function bridgeCoverage(run: RunReport) {
  const checks = run.checks.filter((c) => c.bridge);
  return [...new Set(checks.map((c) => c.bridge!))].map((bridge) => {
    const items = checks.filter((c) => c.bridge === bridge);
    const confirmed = items.filter(
      (c) =>
        c.state === "passed" &&
        (c.evidence === "data" || c.evidence === "device"),
    ).length;
    return {
      bridge,
      confirmed,
      total: items.length,
      percent: Math.floor((100 * confirmed) / items.length),
    };
  });
}
export function summarize(run: RunReport) {
  const count = (state: CheckState) =>
    run.checks.filter((c) => c.state === state).length;
  const passed = count("passed"),
    failed = count("failed"),
    tested = passed + failed;
  const processed = tested + count("skipped") + count("manual");
  return {
    passed,
    failed,
    tested,
    skipped: count("skipped"),
    manual: count("manual"),
    total: run.checks.length,
    processed,
    progress: run.checks.length
      ? Math.floor((processed / run.checks.length) * 100)
      : 0,
    success: tested ? Math.round((passed / tested) * 100) : null,
  };
}
export class CheckTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Нет ответа за ${timeoutMs / 1000} с`);
  }
}
export async function bounded<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs = 12000,
): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      new Promise<T>((_, reject) => {
        abort = () => {
          controller.abort(signal.reason);
          reject(signal.reason ?? new Error("Остановлено"));
        };
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          const error = new CheckTimeout(timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return execute(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export async function runChecks(
  plan: Check[],
  cleanup: Check,
  signal: AbortSignal,
  update: (report: RunReport) => void,
  timeoutMs = 12000,
) {
  const report: RunReport = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    state: "running",
    checks: [...plan, cleanup].map((c) => ({
      id: c.id,
      label: c.label,
      group: c.group,
      bridge: c.bridge,
      evidence: c.evidence,
      state: "pending",
      detail: "Ещё не запускалась",
      durationMs: 0,
    })),
  };
  let cleanupFailed = false;
  const publish = () =>
    update({ ...report, checks: report.checks.map((c) => ({ ...c })) });
  async function execute(
    check: Check,
    index: number,
    currentSignal: AbortSignal,
  ) {
    const result = report.checks[index];
    const start = performance.now();
    let started = false;
    try {
      const skip = check.skip?.();
      if (skip) {
        Object.assign(result, skip);
        return;
      }
      started = true;
      result.state = "running";
      result.detail = "Ожидаем ответ…";
      publish();
      const outcome = await bounded(
        check.execute,
        currentSignal,
        check.timeoutMs ?? timeoutMs,
      );
      currentSignal.throwIfAborted();
      if (typeof outcome === "string") {
        result.detail = outcome;
        result.state = "passed";
      } else Object.assign(result, outcome);
    } catch (error) {
      const unanswered =
        error instanceof CheckTimeout &&
        error.timeoutMs === (check.timeoutMs ?? timeoutMs) &&
        check.timeoutState === "manual";
      result.state = currentSignal.aborted
        ? "cancelled"
        : unanswered
          ? "manual"
          : "failed";
      result.detail = currentSignal.aborted
        ? "Остановлено пользователем"
        : unanswered
          ? "Не проверено: подтверждение пользователя не получено за отведённое время"
          : error instanceof Error
            ? error.message
            : "Проверка завершилась ошибкой";
    } finally {
      if (started && check.finalize) {
        try {
          await bounded(check.finalize, new AbortController().signal, 5000);
        } catch (error) {
          cleanupFailed = true;
          result.state = "failed";
          result.evidence = undefined;
          result.detail += `; восстановление состояния не подтверждено: ${error instanceof Error ? error.message : "ошибка"}. Остальные проверки остановлены`;
        }
      }
      result.durationMs = Math.round(performance.now() - start);
      publish();
    }
  }
  publish();
  try {
    for (let index = 0; index < plan.length; index++) {
      if (signal.aborted || cleanupFailed) break;
      await execute(plan[index], index, signal);
    }
  } finally {
    // Cleanup is independent of cancellation and always bounded.
    await execute(cleanup, plan.length, new AbortController().signal);
    for (const check of report.checks)
      if (check.state === "pending") {
        check.state = "cancelled";
        check.detail = cleanupFailed
          ? "Не запускалась: состояние приложения не восстановлено"
          : "Не запускалась: прогон остановлен";
      }
    report.state = signal.aborted || cleanupFailed ? "cancelled" : "finished";
    report.finishedAt = new Date().toISOString();
    publish();
  }
  return report;
}
