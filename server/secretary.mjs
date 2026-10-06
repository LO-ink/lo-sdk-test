import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createBotClient, createSecretaryClient } from "@lo-ink/bot-sdk";
import { createLoHttpBotTransport } from "@lo-ink/bot-http-lo";

const human = /^[1-9][0-9]{0,14}$/;
const connectionId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class FlowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** One dedicated consumer and one fixed synthetic owner/chat. No ordinary bot polling. */
export function createSecretaryFlow(configuration, dependencies = {}) {
  const token = configuration.LO_SECRETARY_TEST_TOKEN;
  const ownerId = configuration.LO_SECRETARY_TEST_OWNER_ID;
  const peerId = configuration.LO_SECRETARY_TEST_PEER_ID;
  const connection = configuration.LO_SECRETARY_TEST_CONNECTION_ID;
  const path = configuration.LO_SECRETARY_TEST_STATE;
  const botId = token?.split(":")[0];
  const configured = Boolean(
    token &&
    human.test(ownerId ?? "") &&
    human.test(peerId ?? "") &&
    ownerId !== peerId &&
    connectionId.test(connection ?? "") &&
    path &&
    isAbsolute(path) &&
    /^1[0-9]{15}$/.test(botId ?? "") &&
    botId !== configuration.LO_BOT_TOKEN?.split(":")[0] &&
    configuration.LO_SECRETARY_TEST_EXCLUSIVE_POLL === "true",
  );
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const transport = configured
    ? createLoHttpBotTransport({
        token,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      })
    : null;
  const bot = transport ? createBotClient(transport) : null;
  const secretary = transport ? createSecretaryClient(transport) : null;
  let busy = false;
  const publicView = (state) => ({
    configured: true,
    runId: state.runId,
    botId,
    ownerId,
    peerId,
    challenge: state.challenge,
    reply: state.reply,
    connectionVerified: state.connectionVerified === true,
    incomingReceived: Boolean(state.intent),
    attempted: state.attempted === true,
    draft: state.draft ?? null,
    outcome: state.outcome ?? null,
    confirmedAt: state.confirmedAt ?? null,
    expired: state.createdAt + 86400 <= now(),
  });
  async function save(state) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async function load() {
    try {
      const file = await open(path, "r");
      try {
        const stat = await file.stat();
        if (stat.size > 32768 || (stat.mode & 0o077) !== 0)
          throw new FlowError(503, "Приватное хранилище секретаря недоступно");
        const state = JSON.parse(await file.readFile("utf8"));
        if (
          state.botId !== botId ||
          state.ownerId !== ownerId ||
          state.peerId !== peerId ||
          state.connectionId !== connection
        )
          throw new FlowError(
            409,
            "Сохранённая проверка относится к другой конфигурации",
          );
        const integer = (value) =>
          typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
        if (
          !connectionId.test(state.runId ?? "") ||
          !Number.isSafeInteger(state.createdAt) ||
          state.createdAt <= 0 ||
          state.challenge !== `LO SDK Test ${state.runId}` ||
          state.reply !== `LO SDK Test: ответ на проверку ${state.runId}` ||
          (state.offset !== undefined && !integer(state.offset))
        )
          throw new FlowError(409, "Сохранённая проверка повреждена");
        if (
          state.intent &&
          (state.intent.connectionId !== connection ||
            state.intent.requestId !== `sdk-test:${state.runId}` ||
            state.intent.text !== state.reply ||
            state.intent.reason !== "manual_review" ||
            state.intent.context?.chatId !== peerId ||
            ![
              "conversationId",
              "policyVersion",
              "sourceMessageId",
              "sourceRevision",
            ].every((key) => integer(state.intent.context?.[key])))
        )
          throw new FlowError(
            409,
            "Сохранённый запрос не соответствует проверке",
          );
        if (
          state.outcome === "sent" &&
          (state.draft?.state !== "sent" ||
            state.draft?.mode !== "review" ||
            !integer(state.draft?.messageId) ||
            !Number.isSafeInteger(state.confirmedAt))
        )
          throw new FlowError(409, "Сохранённое подтверждение повреждено");
        return state;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function verifyConnection() {
    const current = await secretary.getConnection(connection);
    if (
      current.ownerId !== ownerId ||
      !current.enabled ||
      !current.rights.includes("receive_messages") ||
      !current.rights.includes("send_messages")
    )
      throw new FlowError(403, "Подключение не разрешает эту проверку");
    return current;
  }
  return async function execute(userId, body) {
    if (!configured) return { configured: false };
    if (userId !== ownerId)
      throw new FlowError(
        403,
        "Проверка доступна только настроенному тестовому владельцу",
      );
    if (
      !body ||
      !["status", "start", "incoming", "propose", "verify"].includes(
        body.action,
      ) ||
      Object.keys(body).some((key) => !["action", "runId"].includes(key))
    )
      throw new FlowError(400, "Некорректное действие проверки");
    if (busy) throw new FlowError(409, "Проверка уже выполняется");
    busy = true;
    let lock;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        lock = await open(`${path}.lock`, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST")
          throw new FlowError(
            409,
            "Хранилище занято; после сбоя требуется безопасное восстановление",
          );
        throw error;
      }
      let state = await load();
      if (!state) {
        if (body.action !== "start")
          return { configured: true, botId, ownerId, peerId, started: false };
        const identity = await bot.getIdentity();
        if (identity.id !== botId)
          throw new FlowError(
            403,
            "Тестовый бот не соответствует конфигурации",
          );
        await verifyConnection();
        const runId = randomUUID();
        state = {
          runId,
          botId,
          ownerId,
          peerId,
          connectionId: connection,
          createdAt: now(),
          connectionVerified: true,
          challenge: `LO SDK Test ${runId}`,
          reply: `LO SDK Test: ответ на проверку ${runId}`,
          offset: undefined,
        };
        await save(state);
      }
      if (body.action === "status" || body.action === "start")
        return publicView(state);
      if (body.runId !== state.runId)
        throw new FlowError(404, "Проверка не найдена");
      if (state.createdAt + 86400 <= now())
        throw new FlowError(410, "Проверка истекла; проверьте результат в LO");
      if (state.outcome === "sent" && state.draft?.state === "sent")
        return publicView(state);
      const grant = await verifyConnection();
      if (body.action === "incoming") {
        if (state.intent) return publicView(state);
        const updates = await bot.getUpdates({
          ...(state.offset ? { offset: state.offset } : {}),
          limit: 100,
          waitSeconds: 0,
        });
        for (const update of updates) {
          if (
            update.kind === "secretary_message" &&
            update.message.connectionId === connection &&
            update.message.senderId === peerId &&
            update.context.chatId === peerId &&
            update.context.policyVersion === grant.policyVersion &&
            !update.message.secretaryBotId &&
            update.message.text === state.challenge
          ) {
            state.intent = {
              connectionId: connection,
              context: update.context,
              requestId: `sdk-test:${state.runId}`,
              text: state.reply,
              reason: "manual_review",
            };
            break;
          }
        }
        // Only the configured synthetic challenge/context is retained. Persist before ACK.
        if (updates.length)
          state.offset = String(BigInt(updates.at(-1).id) + 1n);
        await save(state);
        return publicView(state);
      }
      if (!state.intent)
        throw new FlowError(409, "Сначала получите новое тестовое входящее");
      if (body.action === "verify" && !state.attempted)
        throw new FlowError(409, "Черновик ещё не предложен");
      // Durable intent precedes the network call. Retry never replaces it after uncertainty.
      state.attempted = true;
      state.outcome = "unknown";
      await save(state);
      try {
        const draft = await secretary.proposeDraft({
          connectionId: connection,
          context: state.intent.context,
          requestId: `sdk-test:${state.runId}`,
          text: state.reply,
          reason: "manual_review",
        });
        if (draft.mode !== "review" || draft.secretaryBotId !== botId)
          throw new FlowError(409, "Результат требует проверки в LO");
        state.draft = {
          id: draft.id,
          state: draft.state,
          mode: draft.mode,
          revision: draft.revision,
          ...(draft.messageId ? { messageId: draft.messageId } : {}),
        };
        state.outcome =
          draft.state === "sent" && draft.messageId ? "sent" : "received";
        if (state.outcome === "sent") state.confirmedAt = now();
        await save(state);
        return publicView(state);
      } catch (error) {
        // A denial after approval can hide a committed result. It never proves no send.
        state.outcome = "unavailable";
        await save(state);
        throw error;
      }
    } finally {
      if (lock) {
        await lock.close();
        await rm(`${path}.lock`);
      }
      busy = false;
    }
  };
}
