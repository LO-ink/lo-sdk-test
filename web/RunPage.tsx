import {
  Tabs,
  Button,
  Heading,
  Text,
  Progress,
  Surface,
  Stack,
} from "@lo-ink/ui";
import { useState } from "react";
import { SdkVersions } from "./SdkVersions.tsx";
import {
  bridgeCoverage,
  canResume,
  hasRecoveryDebt,
  summarize,
  type AssistedBridge,
  type CheckResult,
  type RunReport,
} from "./runner.ts";
import { RunInteraction } from "./RunInteraction.tsx";
import { canRunDeferred, type DeferredIdentity } from "./deferred.ts";
import type { RecoveryTicket } from "./run-storage.ts";
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
function statusTone(state: CheckResult["state"]) {
  return state === "passed"
    ? "success"
    : state === "failed"
      ? "danger"
      : "secondary";
}
function RunFeed({ checks }: { checks: CheckResult[] }) {
  return (
    <ol className="run-feed">
      {checks.map((check) => (
        <li key={check.id} className={check.state}>
          <Text
            as="span"
            size="caption"
            tone={statusTone(check.state)}
            className="feed-icon"
            aria-hidden="true"
          >
            {check.state === "passed"
              ? check.evidence === "response"
                ? "API"
                : "✓"
              : check.state === "failed"
                ? "×"
                : check.state === "running"
                  ? "…"
                  : "—"}
          </Text>
          <div>
            <Text as="span" size="label" className="feed-title">
              {check.label}
            </Text>
            <div className="feed-meta">
              <Text
                as="span"
                size="caption"
                tone={statusTone(check.state)}
                className="feed-state"
              >
                {check.state === "passed" && check.evidence === "response"
                  ? "Ответ API"
                  : labels[check.state]}
              </Text>
              {check.bridge && (
                <Text as="span" size="caption" tone="secondary">
                  {check.bridge}
                </Text>
              )}
            </div>
            {check.detail &&
              ["failed", "manual", "skipped", "cancelled"].includes(
                check.state,
              ) && (
                <Text
                  tone={check.state === "failed" ? "danger" : "secondary"}
                  size="caption"
                  className="feed-detail"
                >
                  {check.detail}
                </Text>
              )}
          </div>
        </li>
      ))}
    </ol>
  );
}
export function RunPage({
  report,
  assistedBridge = "native",
  onBridgeChange,
  availableBridgeIds = [],
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
  identity = null,
  pendingRecovery = null,
  recovering = false,
  onRecover,
}: {
  pendingRecovery?: RecoveryTicket | null;
  recovering?: boolean;
  onRecover?: () => void;
  report: RunReport | null;
  assistedBridge?: AssistedBridge;
  onBridgeChange?: (bridge: AssistedBridge) => void;
  availableBridgeIds?: AssistedBridge[];
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
  identity?: DeferredIdentity | null;
}) {
  const [filter, setFilter] = useState<keyof typeof filters>("Ошибки");
  const resumable = canResume(report) && Boolean(onResume);
  const active = starting || report?.state === "running";
  const summary = report ? summarize(report) : null;
  const currentIndex =
    report?.checks.findIndex((check) => check.state === "running") ?? -1;
  const current = currentIndex >= 0 ? report?.checks[currentIndex] : undefined;
  const startedChecks =
    report?.checks.filter(
      (check) => check.state !== "pending" && !check.scopeExcluded,
    ) ?? [];
  const feedChecks = startedChecks
    .filter((check) => check.state !== "running")
    .reverse();
  if (current && !interaction) feedChecks.unshift(current);
  const coverage = report ? bridgeCoverage(report) : [];
  const confirmed = coverage.reduce((sum, item) => sum + item.confirmed, 0);
  const bridgeTotal = coverage.reduce((sum, item) => sum + item.total, 0);
  const deferredChecks =
    report?.checks.filter((check) =>
      canRunDeferred(report, check.id, identity),
    ) ?? [];
  const shown =
    report?.checks.filter(
      (c) => !filters[filter] || c.state === filters[filter],
    ) ?? [];
  const groups = [...new Set(shown.map((c) => c.group))];
  if (pendingRecovery)
    return (
      <section
        className="run-panel"
        aria-label="Восстановление прежнего прогона"
      >
        <Stack gap={4}>
          <Heading level={2}>Завершите восстановление</Heading>
          <Text tone="secondary" size="label">
            Прежний прогон относится к другим версиям SDK или старше суток. Его
            результаты не используются. Сначала удалим оставленные тестовые
            ключи и восстановим изменённые настройки; новая проверка станет
            доступна после очистки.
          </Text>
          <Text tone="secondary" size="caption">
            Откройте прежний аккаунт и приложение LO. Недоступные ресурсы
            останутся в списке восстановления до успешной очистки.
          </Text>
          <Button
            disabled={recovering || Boolean(interaction) || !onRecover}
            onClick={onRecover}
          >
            {recovering ? "Восстанавливаем…" : "Восстановить прежний прогон"}
          </Button>
        </Stack>
      </section>
    );
  return (
    <>
      <section className="run-panel" aria-label="Запуск проверки">
        <Stack gap={4}>
          {onBridgeChange && !active && !resumable && (
            <Stack gap={2}>
              <Text size="label">Мост для проверок с вашим участием</Text>
              <Tabs
                aria-label="Мост интерактивных проверок"
                value={assistedBridge}
                onValueChange={(value) =>
                  onBridgeChange(value as AssistedBridge)
                }
                options={[
                  {
                    value: "native",
                    label: "Нативный",
                    disabled: !availableBridgeIds.includes("native"),
                  },
                  {
                    value: "compat",
                    label: "Совместимый",
                    disabled: !availableBridgeIds.includes("compat"),
                  },
                ]}
              />
            </Stack>
          )}
          {onBridgeChange && (
            <Text tone="secondary" size="caption">
              Автоматически — оба моста. С вашим участием —{" "}
              {((active || resumable) && report?.assistedBridge
                ? report.assistedBridge
                : assistedBridge) === "compat"
                ? "совместимый"
                : "нативный"}{" "}
              мост.
            </Text>
          )}
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
                    : "Начать проверку"}
          </Button>
          {!active && !resumable && (
            <Text tone="secondary" size="caption">
              Сначала автоматические проверки, затем действия с вашим
              подтверждением.
            </Text>
          )}
          {resumable && !active && (
            <>
              <Text tone="secondary" size="caption">
                Сохраним готовые результаты и продолжим незавершённые шаги. Для
                прерванных действий снова потребуется подтверждение.
              </Text>
              <Button
                variant="secondary"
                className="run-secondary"
                disabled={Boolean(interaction) || hasRecoveryDebt(report)}
                onClick={onStart}
              >
                Начать заново
              </Button>
            </>
          )}
          {report?.resumeError && !active && (
            <Text
              tone="danger"
              size="caption"
              role="status"
              className="feed-error"
            >
              Не удалось продолжить: {report.resumeError}
            </Text>
          )}
          {(report?.resumeBlocked || hasRecoveryDebt(report)) && !active && (
            <Text tone="secondary" size="caption">
              {resumable
                ? "Восстановление после остановки не подтверждено. При продолжении сначала повторим очистку; готовые результаты останутся."
                : "Восстановление после остановки не подтверждено. Продолжение недоступно; заново откройте приложение в LO и начните новый прогон."}
            </Text>
          )}
          {active && current?.phase && (
            <Text size="label" tone="secondary" role="status">
              {current.phase === "automatic"
                ? "Автоматические проверки"
                : current.phase === "assisted"
                  ? "Проверки с вашим участием"
                  : "Итоги и восстановление"}
            </Text>
          )}
          {active && summary && (
            <Stack gap={2}>
              <div className="run-progress-label">
                <Text as="strong" weight="bold" size="title">
                  {summary.progress}%
                </Text>
                <Text as="span" size="caption">
                  {summary.processed} / {summary.total}
                </Text>
              </div>
              <Progress
                max={100}
                value={summary.progress}
                aria-label="Выполнение проверки"
              />
            </Stack>
          )}
          {active && (stopping || (!current && !interaction)) && (
            <Text
              tone="secondary"
              size="label"
              className="run-current"
              role="status"
            >
              {stopping
                ? "Удаляем тестовые данные…"
                : resuming
                  ? "Восстанавливаем подключение…"
                  : "Запускаем…"}
            </Text>
          )}
        </Stack>
      </section>
      {interaction && (
        <RunInteraction
          key={interaction.title}
          view={interaction}
          onStop={onStop}
        />
      )}
      {active && feedChecks.length > 0 && (
        <section
          className="run-feed-panel"
          aria-label="Ход проверки"
          aria-live="polite"
          aria-relevant="additions text"
        >
          <div className="section-heading">
            <Heading level={2}>Ход проверки</Heading>
            {current && report && (
              <Text
                as="span"
                size="label"
                tone="secondary"
                className="feed-step"
                aria-label={`Шаг ${currentIndex + 1} из ${report.checks.length}`}
              >
                {currentIndex + 1} / {report.checks.length}
              </Text>
            )}
          </div>
          <RunFeed checks={feedChecks.slice(0, 7)} />
          {feedChecks.length > 7 && (
            <details>
              <summary>Предыдущие шаги · {feedChecks.length - 7}</summary>
              <RunFeed checks={feedChecks.slice(7)} />
            </details>
          )}
        </section>
      )}
      {summary && !active && (
        <>
          <Surface
            padding={0}
            className="group run-outcome"
            aria-label="Результат проверки"
          >
            <div className="run-score">
              <Text as="strong" weight="bold" size="display">
                {bridgeTotal
                  ? `${Math.floor((100 * confirmed) / bridgeTotal)}%`
                  : "—"}
              </Text>
              <Stack gap={1}>
                <Heading level={2}>
                  {report?.state === "cancelled"
                    ? "Проверка остановлена"
                    : "Покрытие мостов"}
                </Heading>
                <Text tone="secondary" size="label">
                  Подтверждено {confirmed} из {bridgeTotal} проверок мостов
                </Text>
              </Stack>
            </div>
            <div className="bridge-coverage">
              {coverage.map((item) => (
                <Text tone="secondary" size="label" key={item.bridge}>
                  <Text as="span" size="caption">
                    {item.bridge}
                  </Text>
                  <Text as="strong" weight="bold" size="label">
                    {item.confirmed} / {item.total}
                  </Text>
                </Text>
              ))}
            </div>
            <div className="run-counts">
              <Text as="span" size="caption">
                <Text as="strong" weight="bold" size="title">
                  {summary.passed}
                </Text>
                без ошибок
              </Text>
              <Text as="span" size="caption">
                <Text as="strong" weight="bold" size="title">
                  {summary.failed}
                </Text>
                ошибок
              </Text>
              <Text as="span" size="caption">
                <Text as="strong" weight="bold" size="title">
                  {summary.skipped}
                </Text>
                пропущено
              </Text>
              <Text as="span" size="caption">
                <Text as="strong" weight="bold" size="title">
                  {summary.manual}
                </Text>
                не проверено
              </Text>
            </div>
            <Stack gap={4}>
              <Stack gap={2}>
                {report?.assistedBridge && (
                  <Text tone="secondary" size="caption">
                    С вашим участием проверялся{" "}
                    {report.assistedBridge === "native"
                      ? "нативный"
                      : "совместимый"}{" "}
                    мост. Невыполненные интерактивные сценарии другого моста
                    остаются непроверенными.
                  </Text>
                )}
                <Text tone="secondary" size="caption">
                  Пропуски и непроверенные эффекты снижают покрытие.
                  Синтетические тесты и ответы API без подтверждения эффекта его
                  не повышают.
                </Text>
                {report?.state === "cancelled" && (
                  <Text tone="secondary" size="caption">
                    Обработано {summary.processed} из {summary.total} пунктов.
                  </Text>
                )}
              </Stack>
              <Button
                variant="secondary"
                className="run-secondary"
                disabled={exporting}
                onClick={onExport}
              >
                {exporting ? "Сохраняем…" : "Скачать отчёт"}
              </Button>
            </Stack>
          </Surface>
          <Heading level={2} className="report-heading">
            Отчёт
          </Heading>
          {deferredChecks.length > 0 && (
            <Surface padding={0} className="group deferred-checks">
              <Stack gap={4}>
                <Heading level={3}>Завершающие проверки</Heading>
                <Text tone="secondary" size="caption">
                  Переход в чат и завершающие вызовы могут закрыть приложение.
                  После каждого заново откройте LO SDK Test: сохранённая попытка
                  продолжится. Доставку уже отправленных файлов и закрытие
                  подтвердите вручную; данные проверим у бота по уникальному
                  коду. Повторная кнопка продолжит незавершённую попытку без
                  новой отправки.
                </Text>
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
              </Stack>
            </Surface>
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
              <Heading level={3}>{group}</Heading>
              <Surface padding={0} className="group">
                {shown
                  .filter((c) => c.group === group)
                  .map((check) => (
                    <details
                      key={check.id}
                      className={`run-check ${check.state}`}
                    >
                      <summary>
                        <Text
                          as="span"
                          size="label"
                          weight="medium"
                          className="run-check-name"
                        >
                          {check.label}
                        </Text>
                        <Text
                          as="span"
                          size="caption"
                          tone={
                            check.state === "passed"
                              ? "success"
                              : check.state === "failed"
                                ? "danger"
                                : "secondary"
                          }
                          className="run-state"
                        >
                          {check.state === "passed" &&
                          check.evidence === "response"
                            ? "Ответ API"
                            : labels[check.state]}
                        </Text>
                      </summary>
                      <div className="run-check-detail">
                        <Text as="code" family="mono" size="caption">
                          {check.id}
                        </Text>
                        <Text tone="secondary" size="label">
                          {check.detail}
                        </Text>
                        {canRunDeferred(report, check.id, identity) &&
                          /:(close|sendData)$/.test(check.id) && (
                            <Button
                              variant="secondary"
                              onClick={() => onDeferred(check.id)}
                            >
                              Проверить после прогона
                            </Button>
                          )}
                        {check.durationMs > 0 && (
                          <Text tone="secondary" size="caption">
                            {(check.durationMs / 1000).toFixed(2)} с
                          </Text>
                        )}
                      </div>
                    </details>
                  ))}
              </Surface>
            </section>
          ))}
          {!shown.length && (
            <Text tone="secondary" size="label" className="empty">
              {filter === "Ошибки"
                ? "Ошибок нет. Непроверенные шаги указаны отдельно."
                : "Нет таких результатов."}
            </Text>
          )}
        </>
      )}
      <SdkVersions />
    </>
  );
}
