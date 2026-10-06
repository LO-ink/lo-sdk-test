import { Button, Heading, Text, Stack } from "@lo-ink/ui";
import { useEffect, useRef, useState } from "react";

type Flow = {
  configured: boolean;
  started?: boolean;
  runId?: string;
  botId?: string;
  ownerId?: string;
  peerId?: string;
  challenge?: string;
  reply?: string;
  connectionVerified?: boolean;
  incomingReceived?: boolean;
  attempted?: boolean;
  expired?: boolean;
  outcome?: string | null;
  draft?: { state: string; messageId?: string } | null;
};
type Request = (path: string, body: unknown) => Promise<Flow>;
export function SecretaryPage({
  authenticated,
  request,
}: {
  authenticated: boolean;
  request: Request;
}) {
  const generation = useRef(0);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    generation.current++;
    setFlow(null);
    setError("");
    setBusy(false);
    if (authenticated)
      void request("secretary", { action: "status" }).then(
        (result) => {
          if (current) setFlow(result);
        },
        (failure: Error) => {
          if (current) setError(failure.message);
        },
      );
    return () => {
      current = false;
      generation.current++;
    };
  }, [authenticated, request]);
  const perform = async (action: string) => {
    const current = generation.current;
    setBusy(true);
    setError("");
    if (action === "propose" || action === "verify")
      setFlow((previous) =>
        previous
          ? { ...previous, attempted: true, outcome: "unknown" }
          : previous,
      );
    try {
      const result = await request("secretary", {
        action,
        ...(flow?.runId ? { runId: flow.runId } : {}),
      });
      if (current === generation.current) setFlow(result);
    } catch (failure) {
      if (current === generation.current)
        setError(
          failure instanceof Error ? failure.message : "Проверка недоступна",
        );
      if (
        current === generation.current &&
        (action === "propose" || action === "verify")
      ) {
        try {
          const restored = await request("secretary", { action: "status" });
          if (current === generation.current) setFlow(restored);
        } catch {
          /* Keep the uncertain attempt visible if reconciliation is unavailable. */
        }
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const sent =
    flow?.outcome === "sent" &&
    flow.draft?.state === "sent" &&
    Boolean(flow.draft.messageId);
  return (
    <Stack as="section" className="run-panel" aria-labelledby="secretary-heading">
      <Heading level={2} id="secretary-heading">Секретарь</Heading>
      <Text>
        Проверка отдельного тестового бота: входящее, черновик, одобрение в LO и
        серверное подтверждение отправки.
      </Text>
      {!authenticated && (
        <Text>Откройте стенд в LO и проверьте подпись запуска.</Text>
      )}
      {authenticated && flow?.configured === false && (
        <Text>
          Сценарий пока не настроен. Для него нужны отдельный тестовый бот, два
          тестовых аккаунта и приватное хранилище на сервере.
        </Text>
      )}
      {flow?.configured && (
        <>
          <Text>
            Владелец: {flow.ownerId}. Тестовый собеседник: {flow.peerId}. Бот:{" "}
            {flow.botId}.
          </Text>
          <Text>
            Предварительно подключите этого бота в настройках LO и разрешите
            получение и отправку в тестовом диалоге. Подключение другого
            секретаря может заменить текущего; используйте отдельный тестовый
            аккаунт.
          </Text>
          {!flow.runId && (
            <Button disabled={busy} onClick={() => void perform("start")}>
              Проверить подключение
            </Button>
          )}
          {flow.runId && (
            <>
              <ol aria-label="Этапы проверки">
                <li>
                  {flow.connectionVerified
                    ? "Подключение и права подтверждены сервером"
                    : "Подключение не проверено"}
                </li>
                <li>
                  {flow.incomingReceived
                    ? "Точное тестовое входящее получено"
                    : "Ожидается новое тестовое входящее"}
                </li>
                <li>
                  {flow.draft
                    ? "Черновик подтверждён сервером"
                    : "Черновик не подтверждён"}
                </li>
                <li>
                  {sent
                    ? "Одобрение и отправка подтверждены сервером"
                    : "Одобрение и отправка ещё не подтверждены"}
                </li>
              </ol>
              {!flow.incomingReceived && (
                <>
                  <Text>
                    Попросите тестового собеседника отправить владельцу именно
                    этот текст:
                  </Text>
                  <Text>
                    <Text as="code" family="mono">{flow.challenge}</Text>
                  </Text>
                  <Button
                    disabled={busy || flow.expired}
                    onClick={() => void perform("incoming")}
                  >
                    Проверить входящее
                  </Button>
                </>
              )}
              {flow.incomingReceived && (
                <>
                  <Text>Предлагаемый ответ в этот же тестовый диалог:</Text>
                  <blockquote>{flow.reply}</blockquote>
                  {!flow.draft && (
                    <Button
                      disabled={busy || flow.expired}
                      onClick={() => void perform("propose")}
                    >
                      {flow.attempted
                        ? "Повторить точный запрос"
                        : "Создать черновик для проверки в LO"}
                    </Button>
                  )}
                  {flow.draft && !sent && (
                    <Text>
                      Откройте «Секретарь» в LO и одобрите этот черновик. Затем
                      сразу проверьте результат здесь.
                    </Text>
                  )}
                  {flow.draft && !sent && (
                    <Button
                      variant="secondary"
                      disabled={busy || flow.expired}
                      onClick={() =>
                        void perform(flow.draft ? "verify" : "propose")
                      }
                    >
                      {flow.draft
                        ? "Проверить результат"
                        : "Повторить точный запрос"}
                    </Button>
                  )}
                </>
              )}
              {sent && (
                <Text role="status">
                  Отправка подтверждена. Сообщение №{flow.draft?.messageId}.
                  Проверьте его появление у тестового собеседника отдельно.
                </Text>
              )}
              {flow.outcome === "unknown" || flow.outcome === "unavailable" ? (
                <Text role="status">
                  Результат сейчас неизвестен. Проверьте черновик и диалог в LO;
                  повтор сохраняет прежний ключ и текст.
                </Text>
              ) : null}
              {flow.expired && (
                <Text>
                  Проверка истекла. Сохранённый запрос не заменяется новым;
                  проверьте результат в LO.
                </Text>
              )}
            </>
          )}
        </>
      )}
      {busy && <Text role="status">Проверяем…</Text>}
      {error && <Text role="alert">{error}</Text>}
      <Text>
        <a
          href="https://github.com/LO-ink/lo-developer-tools/blob/main/docs/secretary.md"
          target="_blank"
          rel="noreferrer"
        >
          Руководство для разработчика
        </a>
      </Text>
    </Stack>
  );
}
