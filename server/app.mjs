import { createHash, randomBytes } from "node:crypto";
import { readFile, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyInitData, InitDataError } from "@lo-ink/miniapp-sdk/server";
import {
  createBotClient,
  createLoHttpBotTransport,
  BotError,
  RateLimited,
  NotAllowed,
  BadRequest,
  Unavailable,
} from "@lo-ink/bot-sdk";
import { createSecretaryFlow } from "./secretary.mjs";
import { conformance } from "./conformance.mjs";
import { createVersionChecker } from "./versions.mjs";
import { GoVerifierUnavailable } from "./initdata-go.mjs";
import { retainReport, ReportError } from "./reports.mjs";

const runtimeSdkVersions = Object.fromEntries(
  await Promise.all(
    ["bot-sdk", "miniapp-sdk"].map(async (name) => {
      const manifest = JSON.parse(
        await readFile(
          new URL(
            `../node_modules/@lo-ink/${name}/package.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      return [`@lo-ink/${name}`, manifest.version];
    }),
  ),
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
async function readJson(request, limit) {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new RequestError(415, "Требуется JSON");
  if (Number(request.headers["content-length"]) > limit)
    throw new RequestError(413, "Запрос слишком большой");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, "Запрос слишком большой");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "Некорректный JSON");
  }
}
async function readUpload(request, directory, state, signal) {
  if (request.headers["content-type"] !== "application/octet-stream")
    throw new RequestError(415, "Требуется двоичный файл");
  const length = request.headers["content-length"];
  if (typeof length !== "string" || !/^[1-9][0-9]*$/.test(length))
    throw new RequestError(411, "Требуется размер файла");
  const size = Number(length);
  if (!Number.isSafeInteger(size) || size > 50 << 20)
    throw new RequestError(413, "Файл превышает 50 МиБ");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  state.directory = await mkdtemp(join(directory, "upload-"));
  const path = join(state.directory, "media");
  const file = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let received = 0;
  const abort = () => request.destroy(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of request) {
      received += chunk.length;
      if (received > size)
        throw new RequestError(413, "Размер файла превышает заявленный");
      hash.update(chunk);
      await file.writeFile(chunk);
      signal.throwIfAborted();
    }
    if (received !== size)
      throw new RequestError(400, "Файл передан не полностью");
  } finally {
    signal.removeEventListener("abort", abort);
    await file.close();
  }
  // File-backed Blob keeps media out of the process heap and preserves streaming.
  return { data: await openAsBlob(path), sha256: hash.digest("hex") };
}

function errorResponse(error) {
  if (error instanceof GoVerifierUnavailable)
    return [503, { message: "Проверка подписи Go недоступна" }];
  if (error instanceof InitDataError)
    return [
      401,
      { code: error.code, message: `Подпись запуска отклонена: ${error.code}` },
    ];
  if (error instanceof RateLimited)
    return [
      429,
      {
        code: error.code,
        retryAfterSec: error.retryAfterSec,
        message:
          "LO временно отклонил запрос. Повторите не раньше указанной паузы.",
      },
    ];
  if (error instanceof NotAllowed)
    return [
      403,
      {
        code: error.code,
        message: "Бот не может написать. Проверьте согласие и блокировку бота.",
      },
    ];
  if (error instanceof BadRequest)
    return [
      400,
      {
        code: error.code,
        message: error.description,
        reason: error.details?.reason,
      },
    ];
  if (error instanceof Unavailable)
    return [
      503,
      {
        code: error.code,
        reason: error.details?.reason,
        message: "LO временно недоступен. Автоповтора нет: возможен дубль.",
      },
    ];
  if (error instanceof BotError)
    return [400, { code: error.code, message: error.message }];
  if (
    error instanceof RequestError ||
    error instanceof ReportError ||
    [400, 403, 404, 409, 410, 503].includes(error.status)
  )
    return [error.status, { message: error.message }];
  return [500, { message: "Сервер не выполнил проверку" }];
}
/** Dependencies are injected only for server integration tests; runtime uses native fetch. */
export function createHandler(configuration = process.env, dependencies = {}) {
  const checkVersions =
    dependencies.checkVersions ??
    createVersionChecker({
      loadBuild: async () =>
        JSON.parse(await readFile(resolve(root, "sdk-build.json"), "utf8")),
    });
  const config = {
    appId: configuration.LO_APP_ID,
    appKey: configuration.LO_APP_KEY,
    token: configuration.LO_BOT_TOKEN,
    appUrl: configuration.LO_APP_URL,
    publicOrigin: configuration.PUBLIC_ORIGIN,
  };
  const appConfigured = Boolean(config.appId && config.appKey);
  const botConfigured = Boolean(config.token && config.appUrl);
  const allowedUsers = new Set(
    (configuration.LO_TEST_USER_IDS ?? "").split(",").filter(Boolean),
  );
  const sessions = new Map();
  const budgets = new Map();
  const reports = new Map();
  let polling = false;
  let activePosts = 0;
  let uploadActive = false;
  const uploadDirectory =
    configuration.LO_UPLOAD_DIR ?? join(tmpdir(), "lo-sdk-test-uploads");
  const secretaryFlow = createSecretaryFlow(configuration, dependencies);
  const client = botConfigured
    ? createBotClient(
        createLoHttpBotTransport({
          token: config.token,
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        }),
      )
    : null;
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const json = (response, status, body) => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify(body));
  };
  function findSession(request) {
    const id = request.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("sdk_test="))
      ?.slice(9);
    const value = sessions.get(id);
    if (!value || value.expires <= now()) {
      if (id) sessions.delete(id);
      return null;
    }
    return value;
  }
  function session(request) {
    const value = findSession(request);
    if (!value)
      throw new RequestError(401, "Сначала проверьте подпись запуска");
    return value;
  }
  const markup = () => ({
    inlineKeyboard: [
      [{ text: "Открыть тесты", miniApp: { url: config.appUrl } }],
    ],
  });
  return async function handler(request, response) {
    let activeSession;
    let admitted = false;
    let uploading = false;
    const uploadState = {};
    let uploadSignal;
    let uploadDigest;
    let disconnect;
    const uploadController = new AbortController();
    async function cleanUpload() {
      if (uploadState.directory) {
        await rm(uploadState.directory, { recursive: true });
        delete uploadState.directory;
      }
    }
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname.startsWith("/reports/")) {
        if (!["GET", "HEAD"].includes(request.method))
          throw new RequestError(405, "Метод недоступен");
        const report = reports.get(url.pathname);
        if (!report || report.expires <= now()) {
          reports.delete(url.pathname);
          throw new RequestError(404, "Ссылка на отчёт истекла");
        }
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition":
            'attachment; filename="lo-sdk-test-report.json"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(request.method === "HEAD" ? undefined : report.data);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (request.method === "GET" && url.pathname === "/api/sdk-versions") {
          json(response, 200, await checkVersions());
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/status") {
          json(response, 200, {
            appConfigured,
            botConfigured,
            sdkVersions: runtimeSdkVersions,
            signatureVerifiers: dependencies.verifyWithGo
              ? ["Node HMAC", "Go HMAC"]
              : ["Node HMAC"],
            origin: config.publicOrigin ?? null,
          });
          return;
        }
        if (request.method !== "POST")
          throw new RequestError(405, "Метод недоступен");
        if (request.headers["x-sdk-test"] !== "1")
          throw new RequestError(403, "Требуется запрос тестового приложения");
        const origins = [
          config.publicOrigin,
          "http://127.0.0.1:5177",
          "http://localhost:5177",
          "http://127.0.0.1:5407",
          "http://localhost:5407",
        ]
          .filter(Boolean)
          .map((value) => new URL(value).origin);
        if (request.headers.origin && !origins.includes(request.headers.origin))
          throw new RequestError(403, "Недопустимый источник запроса");
        if (activePosts >= 8)
          throw new RequestError(429, "Сервер занят. Повторите проверку позже");
        activePosts++;
        admitted = true;
        if (["/api/session", "/api/verify-launch"].includes(url.pathname)) {
          if (!appConfigured)
            throw new RequestError(
              503,
              "Ключ приложения ещё не настроен на сервере",
            );
          const body = await readJson(request, 70000);
          const verificationOptions = {
            appKey: config.appKey,
            appId: config.appId,
            maxAgeSec: 3600,
            nowSec: now(),
          };
          const launch = verifyInitData(body?.raw, verificationOptions);
          if (
            !launch.user ||
            (allowedUsers.size && !allowedUsers.has(launch.user.id))
          )
            throw new RequestError(403, "Нет доступа к тестовому приложению");
          const verifiers = ["Node HMAC"];
          if (dependencies.verifyWithGo) {
            const secondary = await dependencies.verifyWithGo(
              body.raw,
              verificationOptions,
            );
            if (
              secondary?.verified !== true ||
              secondary.userId !== launch.user.id ||
              secondary.appId !== launch.appId ||
              secondary.authDate !== launch.authDate
            )
              throw new RequestError(
                503,
                "Результаты проверки Node и Go не совпали",
              );
            verifiers.push("Go HMAC");
          }
          if (url.pathname === "/api/verify-launch") {
            json(response, 200, {
              verified: true,
              verifier: verifiers.join(" + "),
              verifiers,
              userId: launch.user.id,
              appId: launch.appId,
            });
            return;
          }
          if (
            (body.runId !== undefined &&
              (typeof body.runId !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                  body.runId,
                ))) ||
            (body.resume !== undefined && typeof body.resume !== "boolean") ||
            (body.resume && !body.runId)
          )
            throw new RequestError(400, "Некорректный идентификатор прогона");
          const presented = body.resume ? findSession(request) : null;
          const previous =
            presented?.userId === launch.user.id &&
            presented.runId === body.runId
              ? presented
              : null;
          if (previous)
            for (const [id, value] of sessions)
              if (value === previous) sessions.delete(id);
          for (const [id, value] of sessions)
            if (value.expires <= now()) sessions.delete(id);
          if (sessions.size >= 500)
            throw new RequestError(429, "Слишком много тестовых сессий");
          for (const [userId, budget] of budgets)
            if (budget.expires <= now() && now() - budget.lastSend >= 2)
              budgets.delete(userId);
          const expires = Math.min(now() + 3600, launch.authDate + 3600);
          let budget = budgets.get(launch.user.id);
          if (!budget) {
            if (budgets.size >= 1000)
              throw new RequestError(
                429,
                "Слишком много тестовых пользователей",
              );
            budget = { expires, lastSend: -Infinity };
            budgets.set(launch.user.id, budget);
          } else budget.expires = Math.max(budget.expires, expires);
          const id = randomBytes(32).toString("base64url");
          sessions.set(id, {
            userId: launch.user.id,
            expires,
            allowed: false,
            runId: body.runId,
            files: { ...previous?.files },
            ...(previous?.messageId ? { messageId: previous.messageId } : {}),
            ...(previous?.fileMetadata
              ? { fileMetadata: previous.fileMetadata }
              : {}),
            ...(previous?.documentDigest
              ? { documentDigest: previous.documentDigest }
              : {}),
            budget,
          });
          response.setHeader(
            "set-cookie",
            `sdk_test=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${config.publicOrigin?.startsWith("https:") ? "; Secure" : ""}`,
          );
          json(response, 200, {
            verified: true,
            verifier: verifiers.join(" + "),
            verifiers,
            userId: launch.user.id,
            appId: launch.appId,
            resources: {
              message: Boolean(previous?.messageId),
              files: Object.keys(previous?.files ?? {}),
              metadata: Boolean(previous?.fileMetadata),
            },
          });
          return;
        }
        if (url.pathname === "/api/secretary") {
          const current = session(request);
          const body = await readJson(request, 1024);
          json(response, 200, await secretaryFlow(current.userId, body));
          return;
        }
        if (url.pathname === "/api/consent") {
          const current = session(request);
          const body = await readJson(request, 1024);
          if (typeof body?.allowed !== "boolean")
            throw new RequestError(400, "Ожидается ответ о согласии");
          current.allowed = body.allowed;
          json(response, 200, { accepted: true });
          return;
        }
        if (url.pathname === "/api/send-data/verify") {
          const current = session(request);
          if (!client) throw new RequestError(503, "Тестовый бот не настроен");
          const body = await readJson(request, 1024);
          if (
            typeof body?.data !== "string" ||
            !/^lo-sdk-test:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
              body.data,
            )
          )
            throw new RequestError(400, "Ожидается код текущей попытки");
          if (body.userId !== current.userId || body.appId !== config.appId)
            throw new RequestError(
              403,
              "Попытка относится к другому пользователю или приложению",
            );
          if (polling)
            throw new RequestError(409, "Проверка обновлений уже выполняется");
          if (now() - current.budget.lastSend < 2)
            throw new RequestError(
              429,
              "Дождитесь 2 секунд между тестами бота",
            );
          current.budget.lastSend = now();
          polling = true;
          try {
            // Read only: no offset advancement, no messages sent, no foreign data returned.
            const updates = await client.getUpdates({
              limit: 100,
              waitSeconds: 0,
            });
            const found = updates.some(
              (update) =>
                update.kind === "appData" &&
                update.appData.conversationId === current.userId &&
                (update.appData.userId === undefined ||
                  update.appData.userId === current.userId) &&
                update.appData.data === body.data,
            );
            json(response, 200, { found });
          } finally {
            polling = false;
          }
          return;
        }
        if (url.pathname === "/api/report") {
          const current = session(request);
          const body = await readJson(request, 512 << 10);
          const path = retainReport(reports, current, body?.report, now());
          json(response, 200, { path });
          return;
        }
        if (["/api/bot", "/api/bot/upload"].includes(url.pathname)) {
          const upload = url.pathname === "/api/bot/upload";
          const current = findSession(request);
          activeSession = current;
          let body;
          if (upload) {
            if (!current)
              throw new RequestError(401, "Сначала проверьте подпись запуска");
            const operation = url.searchParams.get("operation");
            const name = url.searchParams.get("name");
            const mime = url.searchParams.get("mime");
            if (
              !["sendPhoto", "sendDocument", "sendVoice", "sendVideo"].includes(
                operation,
              ) ||
              !name ||
              Buffer.byteLength(name) > 255 ||
              // eslint-disable-next-line no-control-regex -- Reject control bytes in uploaded names.
              /[/\\\x00-\x1f\x7f]/.test(name) ||
              (mime &&
                (mime.length > 128 || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)))
            )
              throw new RequestError(400, "Некорректные параметры файла");
            body = { operation, file: { name, ...(mime ? { mime } : {}) } };
          } else {
            body = await readJson(request, 4096);
          }
          if (body?.operation === "conformance") {
            json(response, 200, await conformance());
            return;
          }
          if (!current)
            throw new RequestError(401, "Сначала проверьте подпись запуска");
          if (!client)
            throw new RequestError(
              503,
              "Токен бота или URL приложения не настроен",
            );
          const operation = body?.operation;
          if (
            ![
              "getIdentity",
              "getCapabilities",
              "getFile",
              "downloadFile",
              "getCommands",
              "setCommands",
              "setChatMenuButton",
            ].includes(operation) &&
            !current.allowed
          )
            throw new RequestError(403, "Сначала разрешите боту сообщения");
          if (now() - current.budget.lastSend < 2)
            throw new RequestError(
              429,
              "Дождитесь 2 секунд между тестами бота",
            );
          if (upload) {
            if (uploadActive)
              throw new RequestError(429, "Другая загрузка ещё выполняется");
            uploadActive = true;
            uploading = true;
            current.budget.lastSend = now();
            uploadSignal = AbortSignal.any([
              uploadController.signal,
              AbortSignal.timeout(60000),
            ]);
            disconnect = () => {
              if (!response.writableFinished)
                uploadController.abort(new Error("Upload client disconnected"));
            };
            response.once("close", disconnect);
            const media = await readUpload(
              request,
              uploadDirectory,
              uploadState,
              uploadSignal,
            );
            body.file.data = media.data;
            uploadDigest = media.sha256;
          } else {
            current.budget.lastSend = now();
          }
          const conversationId = current.userId;
          let result;
          if (operation === "getIdentity") result = await client.getIdentity();
          else if (operation === "getCapabilities") {
            const capabilities = await client.getCapabilities({
              refresh: true,
            });
            result = {
              known: capabilities !== undefined,
              capabilities: capabilities ?? null,
            };
          } else if (operation === "getFile") {
            if (!current.files.document)
              throw new RequestError(400, "Сначала отправьте документ");
            result = await client.getFile(current.files.document);
            current.fileMetadata = result;
          } else if (operation === "downloadFile") {
            if (!current.fileMetadata?.path)
              throw new RequestError(
                400,
                "Сначала получите путь документа через getFile",
              );
            const stream = await client.downloadFile({
              path: current.fileMetadata.path,
              maxBytes: 50 << 20,
            });
            const hash = createHash("sha256");
            let bytes = 0;
            const reader = stream.getReader();
            try {
              for (;;) {
                const item = await reader.read();
                if (item.done) break;
                bytes += item.value.byteLength;
                hash.update(item.value);
              }
            } finally {
              reader.releaseLock();
            }
            if (
              current.fileMetadata.size !== undefined &&
              bytes !== current.fileMetadata.size
            )
              throw new RequestError(
                502,
                "Размер скачанного файла не совпал с getFile",
              );
            const sha256 = hash.digest("hex");
            if (current.documentDigest && sha256 !== current.documentDigest)
              throw new RequestError(
                502,
                "Содержимое скачанного файла не совпало с загруженным документом",
              );
            result = {
              bytes,
              sha256,
              verifiedContent: Boolean(current.documentDigest),
            };
          } else if (
            operation === "photoAlbum" ||
            operation === "documentAlbum"
          ) {
            const kind = operation === "photoAlbum" ? "photo" : "document";
            if (!current.files[kind])
              throw new RequestError(400, "Сначала отправьте файл этого типа");
            result = await client.sendMediaGroup({
              conversationId,
              media: [
                {
                  type: kind,
                  media: { fileId: current.files[kind] },
                  caption: "LO SDK Test: альбом",
                },
                {
                  type: kind,
                  media:
                    kind === "document"
                      ? {
                          data: new TextEncoder().encode(
                            "LO SDK Test: второй документ\n",
                          ),
                          name: "sdk-test-second.txt",
                          mime: "text/plain",
                        }
                      : { fileId: current.files[kind] },
                },
              ],
            });
          } else if (operation === "getUpdates") {
            if (polling)
              throw new RequestError(
                409,
                "Проверка обновлений уже выполняется",
              );
            polling = true;
            try {
              const updates = await client.getUpdates({
                limit: 100,
                waitSeconds: 0,
              });
              result = updates.filter(
                (update) =>
                  (update.kind === "message" &&
                    update.message.conversationId === current.userId) ||
                  (update.kind === "appData" &&
                    update.appData.conversationId === current.userId &&
                    (update.appData.userId === undefined ||
                      update.appData.userId === current.userId)) ||
                  (update.kind === "callback" &&
                    update.callback.userId === current.userId &&
                    (!update.callback.message ||
                      update.callback.message.conversationId ===
                        current.userId)),
              );
            } finally {
              polling = false;
            }
          } else if (operation === "getCommands")
            result = await client.getCommands();
          else if (operation === "setCommands")
            result = await client.setCommands([
              { name: "test", description: "Открыть SDK Test" },
            ]);
          else if (operation === "setChatMenuButton")
            result = await client.setChatMenuButton({
              conversationId,
              menuButton: {
                type: "miniApp",
                text: "SDK Test",
                miniApp: { url: config.appUrl },
              },
            });
          else if (operation === "sendMessage") {
            result = await client.sendMessage({
              conversationId,
              text: "LO SDK Test: сообщение с кнопкой",
              replyMarkup: markup(),
            });
            current.messageId = result.id;
          } else if (
            operation === "editMessage" ||
            operation === "deleteMessage"
          ) {
            if (!current.messageId)
              throw new RequestError(
                400,
                "Сначала отправьте тестовое сообщение",
              );
            result =
              operation === "editMessage"
                ? await client.editMessage({
                    conversationId,
                    messageId: current.messageId,
                    text: "LO SDK Test: сообщение изменено",
                    replyMarkup: markup(),
                  })
                : await client.deleteMessage({
                    conversationId,
                    messageId: current.messageId,
                  });
            if (operation === "deleteMessage") delete current.messageId;
          } else if (
            [
              "sendPhoto",
              "sendDocument",
              "sendVoice",
              "sendVideo",
              "reusePhoto",
              "reuseDocument",
              "reuseVoice",
              "reuseVideo",
            ].includes(operation)
          ) {
            const kind = operation.endsWith("Photo")
              ? "photo"
              : operation.endsWith("Document")
                ? "document"
                : operation.endsWith("Video")
                  ? "video"
                  : "voice";
            let inputFile;
            if (operation.startsWith("reuse")) {
              if (!current.files[kind])
                throw new RequestError(
                  400,
                  "Сначала загрузите файл этого типа",
                );
              inputFile = { fileId: current.files[kind] };
            } else {
              if (!upload)
                throw new RequestError(400, "Выберите файл для загрузки");
              inputFile = body.file;
            }
            try {
              result = await client[
                kind === "photo"
                  ? "sendPhoto"
                  : kind === "document"
                    ? "sendDocument"
                    : kind === "video"
                      ? "sendVideo"
                      : "sendVoice"
              ](
                {
                  conversationId,
                  [kind]: inputFile,
                  replyMarkup: markup(),
                  ...(kind === "voice" ? {} : { caption: "LO SDK Test: файл" }),
                },
                uploadSignal ? { signal: uploadSignal } : undefined,
              );
              current.files[kind] = result.fileId;
              if (kind === "document") {
                delete current.fileMetadata;
                if (!operation.startsWith("reuse"))
                  current.documentDigest = uploadDigest;
              }
            } catch (error) {
              if (
                error instanceof BadRequest &&
                /wrong file identifier/i.test(error.description)
              )
                delete current.files[kind];
              throw error;
            }
          } else throw new RequestError(400, "Неизвестная проверка бота");
          await cleanUpload();
          json(response, 200, { mode: "live", operation, result });
          return;
        }
        throw new RequestError(404, "Проверка не найдена");
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new RequestError(405, "Метод недоступен");
      if (url.pathname === "/fixtures/test.txt") {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("LO SDK Test\n");
        return;
      }
      const relative = decodeURIComponent(url.pathname);
      if (relative.includes("..") || relative.includes("\0"))
        throw new RequestError(404, "Страница не найдена");
      const path =
        relative === "/"
          ? resolve(root, "index.html")
          : resolve(root, `.${relative}`);
      if (!path.startsWith(`${root}/`))
        throw new RequestError(404, "Страница не найдена");
      let data;
      try {
        data = await readFile(path);
      } catch {
        throw new RequestError(404, "Страница не найдена");
      }
      response.writeHead(200, {
        "content-type":
          contentTypes[extname(path)] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "no-cache",
      });
      response.end(request.method === "HEAD" ? undefined : data);
    } catch (caught) {
      let error = caught;
      try {
        await cleanUpload();
      } catch {
        error = new RequestError(503, "Временное хранилище файлов недоступно");
      }
      if (error instanceof NotAllowed && activeSession)
        activeSession.allowed = false;
      const [status, body] = errorResponse(error);
      if ([411, 413, 429].includes(status)) response.shouldKeepAlive = false;
      if (!response.headersSent) json(response, status, body);
      else response.end();
    } finally {
      if (disconnect) response.removeListener("close", disconnect);
      // Failed cleanup keeps upload admission closed until restart and recovery.
      if (uploading && !uploadState.directory) uploadActive = false;
      if (admitted) activePosts--;
    }
  };
}
