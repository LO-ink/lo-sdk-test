import { Button } from "@lo-ink/ui";
import { useState } from "react";
import { SdkVersions } from "./SdkVersions.tsx";
import {
  bridgeCoverage,
  canResume,
  hasRecoveryDebt,
  summarize,
  type CheckResult,
  type RunReport,
} from "./runner.ts";
import { RunInteraction } from "./RunInteraction.tsx";
import { canVerifyDelivery, isDeferredCheck } from "./deferred.ts";
import type { InteractionView } from "./interaction.ts";
const labels = {
  pending: "Ожидает",
  running: "Проверяем",
  passed: "Подтверждено",
  failed: "Ошибка",
  skipped: "Пропущено",
  manual: "Не проверено",
  cancelled: "Остановлено",
};
const filters = {
  Все: null,
  Ошибки: "failed",
  Пропуски: "skipped",
  "Не проверено": "manual",
} as const;
function RunFeed({ checks }: { checks: CheckResult[] }) {
  return (
    <ol className="run-feed">
      {checks.map((check) => (
        <li key={check.id} className={check.state}>
          <span className="feed-icon" aria-hidden="true">
            {check.state === "passed"
              ? check.evidence === "response"
                ? "API"
                : "✓"
              : check.state === "failed"
                ? "×"
                : check.state === "running"
                  ? "…"
                  : "—"}
          </span>
          <div>
            <strong>{check.label}</strong>
            {check.bridge && (
              <span className="feed-bridge">{check.bridge}</span>
            )}
            {check.state === "failed" && (
              <p className="feed-error">{check.detail}</p>
            )}
          </div>
          <span className="feed-state">
            {check.state === "passed" && check.evidence === "response"
              ? "Ответ API"
              : labels[check.state]}
          </span>
        </li>
      ))}
    </ol>
  );
}
export function RunPage({
  report,
  interaction,
  starting,
  stopping,
  exporting,
  onStart,
  onResume,
  resuming,
  onStop,
  onExport,
  onDeferred,
}: {
  report: RunReport | null;
  interaction: InteractionView | null;
  starting: boolean;
  stopping: boolean;
  exporting: boolean;
  onStart: () => void;
  onResume?: () => void;
  resuming?: boolean;
  onStop: () => void;
  onExport: () => void;
  onDeferred: (id: string) => void;
}) {
  const [filter, setFilter] = useState<keyof typeof filters>("Ошибки");
  const resumable = canResume(report) && Boolean(onResume);
  const active = starting || report?.state === "running";
  const summary = report ? summarize(report) : null;
  const current = report?.checks.find((c) => c.state === "running");
  const startedChecks =
    report?.checks.filter((check) => check.state !== "pending") ?? [];
  const coverage = report ? bridgeCoverage(report) : [];
  const confirmed = coverage.reduce((sum, item) => sum + item.confirmed, 0);
  const bridgeTotal = coverage.reduce((sum, item) => sum + item.total, 0);
  const deferredChecks =
    report?.checks.filter(
      (check) =>
        check.state === "manual" &&
        isDeferredCheck(check.id) &&
        (check.id !== "bot:delivery" || canVerifyDelivery(report)),
    ) ?? [];
  const shown =
    report?.checks.filter(
      (c) => !filters[filter] || c.state === filters[filter],
    ) ?? [];
  const groups = [...new Set(shown.map((c) => c.group))];
  return (
    <>
      <section className="run-panel" aria-label="Запуск проверки">
        <Button
          className="run-start"
          disabled={stopping || (!active && Boolean(interaction))}
          onClick={active ? onStop : resumable ? onResume : onStart}
        >
          {stopping
            ? "Останавливаем…"
            : active
              ? "Остановить проверку"
              : resumable
                ? "Продолжить проверку"
                : report
                  ? "Проверить снова"
                  : "Проверить все мосты"}
        </Button>
        {resumable && !active && (
          <>
            <p className="note">
              Сохраним готовые результаты и продолжим незавершённые шаги. Для
              прерванных действий снова потребуется подтверждение.
            </p>
            <Button
              variant="secondary"
              disabled={Boolean(interaction) || hasRecoveryDebt(report)}
              onClick={onStart}
            >
              Начать заново
            </Button>
          </>
        )}
        {report?.resumeError && !active && (
          <p role="status" className="feed-error">
            Не удалось продолжить: {report.resumeError}
          </p>
        )}
        {(report?.resumeBlocked || hasRecoveryDebt(report)) && !active && (
          <p className="note">
            {resumable
              ? "Восстановление после остановки не подтверждено. При продолжении сначала повторим очистку; готовые результаты останутся."
              : "Восстановление после остановки не подтверждено. Продолжение недоступно; заново откройте приложение в LO и начните новый прогон."}
          </p>
        )}
        {active && summary && (
          <>
            <div className="run-progress-label">
              <strong>{summary.progress}%</strong>
              <span>
                {summary.processed} / {summary.total}
              </span>
            </div>
            <progress
              max={100}
              value={summary.progress}
              aria-label="Выполнение проверки"
            />
          </>
        )}
        {active && (
          <p className="run-current" role="status">
            {stopping
              ? "Удаляем тестовые данные…"
              : current
                ? `${current.bridge ? `${current.bridge} · ` : ""}${current.label}`
                : resuming
                  ? "Восстанавливаем подключение…"
                  : "Запускаем…"}
          </p>
        )}
      </section>
      {interaction && (
        <RunInteraction
          key={interaction.title}
          view={interaction}
          onStop={onStop}
        />
      )}
      {active && startedChecks.length > 0 && (
        <section className="run-feed-panel" aria-label="Ход проверки">
          <h2>Сейчас проверяется</h2>
          <p className="feed-current">
            {current
              ? `${current.bridge ? `${current.bridge} · ` : ""}${current.label}`
              : "Завершение"}
          </p>
          <RunFeed checks={startedChecks.slice(-7)} />
          {startedChecks.length > 7 && (
            <details>
              <summary>Все шаги · {startedChecks.length}</summary>
              <RunFeed checks={startedChecks} />
            </details>
          )}
        </section>
      )}
      {summary && !active && (
        <>
          <section
            className="group run-outcome"
            aria-label="Результат проверки"
          >
            <div className="run-score">
              <strong>
                {bridgeTotal
                  ? `${Math.floor((100 * confirmed) / bridgeTotal)}%`
                  : "—"}
              </strong>
              <div>
                <h2>
                  {report?.state === "cancelled"
                    ? "Проверка остановлена"
                    : "Покрытие мостов"}
                </h2>
                <p>
                  Подтверждено {confirmed} из {bridgeTotal} проверок мостов
                </p>
              </div>
            </div>
            <div className="bridge-coverage">
              {coverage.map((item) => (
                <p key={item.bridge}>
                  <span>{item.bridge}</span>
                  <strong>
                    {item.confirmed} / {item.total}
                  </strong>
                </p>
              ))}
            </div>
            <div className="run-counts">
              <span>
                <strong>{summary.passed}</strong>без ошибок
              </span>
              <span>
                <strong>{summary.failed}</strong>ошибок
              </span>
              <span>
                <strong>{summary.skipped}</strong>пропущено
              </span>
              <span>
                <strong>{summary.manual}</strong>не проверено
              </span>
            </div>
            <p className="note">
              Пропуски и непроверенные эффекты снижают покрытие. Синтетические
              тесты и ответы API без подтверждения эффекта его не повышают.
            </p>
            {report?.state === "cancelled" && (
              <p className="note">
                Обработано {summary.processed} из {summary.total} пунктов.
              </p>
            )}
            <Button variant="secondary" disabled={exporting} onClick={onExport}>
              {exporting ? "Сохраняем…" : "Скачать отчёт"}
            </Button>
          </section>
          <h2 className="report-heading">Отчёт</h2>
          {deferredChecks.length > 0 && (
            <section className="group deferred-checks">
              <h3>Завершающие проверки</h3>
              <p className="note">
                Переход в чат и завершающие вызовы могут закрыть приложение.
                После каждого заново откройте LO SDK Test: сохранённая попытка
                продолжится. Доставку уже отправленных файлов и закрытие
                подтвердите вручную; данные проверим у бота по уникальному коду.
                Повторная кнопка продолжит незавершённую попытку без новой
                отправки.
              </p>
              {deferredChecks.map((check) => (
                <Button
                  key={check.id}
                  variant="secondary"
                  onClick={() => onDeferred(check.id)}
                >
                  {check.bridge ? `${check.bridge} · ` : ""}
                  {check.label}
                </Button>
              ))}
            </section>
          )}
          <div className="filters report-filters" aria-label="Фильтр отчёта">
            {(Object.keys(filters) as (keyof typeof filters)[]).map((name) => (
              <Button
                key={name}
                variant={filter === name ? "primary" : "secondary"}
                aria-pressed={filter === name}
                onClick={() => setFilter(name)}
              >
                {name}
              </Button>
            ))}
          </div>
          {groups.map((group) => (
            <section key={group} className="run-report-group">
              <h3>{group}</h3>
              <div className="group">
                {shown
                  .filter((c) => c.group === group)
                  .map((check) => (
                    <details
                      key={check.id}
                      className={`run-check ${check.state}`}
                    >
                      <summary>
                        <span className="run-check-name">{check.label}</span>
                        <span className="run-state">
                          {check.state === "passed" &&
                          check.evidence === "response"
                            ? "Ответ API"
                            : labels[check.state]}
                        </span>
                      </summary>
                      <div className="run-check-detail">
                        <code>{check.id}</code>
                        <p>{check.detail}</p>
                        {check.state === "manual" &&
                          /:(close|sendData)$/.test(check.id) && (
                            <Button
                              variant="secondary"
                              onClick={() => onDeferred(check.id)}
                            >
                              Проверить после прогона
                            </Button>
                          )}
                        {check.durationMs > 0 && (
                          <p className="note">
                            {(check.durationMs / 1000).toFixed(2)} с
                          </p>
                        )}
                      </div>
                    </details>
                  ))}
              </div>
            </section>
          ))}
          {!shown.length && (
            <p className="empty">
              {filter === "Ошибки"
                ? "Ошибок нет. Непроверенные шаги указаны отдельно."
                : "Нет таких результатов."}
            </p>
          )}
        </>
      )}
      <SdkVersions />
    </>
  );
}
