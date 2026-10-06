import {
  createBotClient,
  RateLimited,
  NotAllowed,
  BadRequest,
  Unavailable,
} from "@lo-ink/bot-sdk";
import { createLoHttpBotTransport } from "@lo-ink/bot-http-lo";

/** Deliberately synthetic API errors; never sends or floods the real platform. */
export async function conformance() {
  const results = [];
  for (const [status, description, Constructor] of [
    [400, "Bad Request: wrong file identifier/HTTP URL specified", BadRequest],
    [403, "Forbidden: bot was blocked by the user", NotAllowed],
    [429, "Too Many Requests: retry after 7", RateLimited],
    [503, "Service Unavailable", Unavailable],
  ]) {
    const client = createBotClient(
      createLoHttpBotTransport({
        token: "42:synthetic-test-token",
        fetch: async () =>
          Response.json(
            {
              ok: false,
              error_code: status,
              description,
              parameters: { retry_after: 7 },
            },
            { status },
          ),
      }),
    );
    let passed = false;
    try {
      await client.sendMessage({ conversationId: "42", text: "synthetic" });
    } catch (error) {
      passed =
        error instanceof Constructor &&
        (status !== 429 || error.retryAfterSec === 7);
    }
    results.push({ test: `${status} → ${Constructor.name}`, passed });
  }
  let networkCalls = 0;
  const client = createBotClient(
    createLoHttpBotTransport({
      token: "42:synthetic-test-token",
      fetch: async () => {
        networkCalls++;
        throw new Error("Unexpected network");
      },
    }),
  );
  for (const [name, call] of [
    [
      "URL instead of photo",
      () =>
        client.sendPhoto({
          conversationId: "42",
          photo: { fileId: "https://example.test/a.png" },
        }),
    ],
    [
      "HTTP mini-app button",
      () =>
        client.sendMessage({
          conversationId: "42",
          text: "x",
          replyMarkup: {
            inlineKeyboard: [
              [{ text: "x", miniApp: { url: "http://example.test/" } }],
            ],
          },
        }),
    ],
    [
      "long UTF-16 caption",
      () =>
        client.sendPhoto({
          conversationId: "42",
          photo: { fileId: "fake-id" },
          caption: "😀".repeat(513),
        }),
    ],
    [
      "int64 overflow",
      () =>
        client.sendMessage({
          conversationId: "9223372036854775808",
          text: "x",
        }),
    ],
    [
      "cached video upload metadata",
      () =>
        client.sendVideo({
          conversationId: "42",
          video: { fileId: "cached" },
          width: 160,
        }),
    ],
    [
      "mixed album",
      () =>
        client.sendMediaGroup({
          conversationId: "42",
          media: [
            { type: "photo", media: { fileId: "one" } },
            { type: "document", media: { fileId: "two" } },
          ],
        }),
    ],
    [
      "download traversal",
      () => client.downloadFile({ path: "folder/%2e%2e/file" }),
    ],
    [
      "audio upload unavailable",
      () =>
        client.sendAudio({
          conversationId: "42",
          audio: { data: new Uint8Array([1]), name: "test.mp3" },
        }),
    ],
    [
      "voice Blob with unsupported MIME",
      () =>
        client.sendVoice({
          conversationId: "42",
          voice: {
            data: new Blob(["synthetic"], { type: "audio/ogg" }),
            name: "voice.m4a",
          },
        }),
    ],
  ]) {
    let passed = false;
    try {
      await call();
    } catch (error) {
      passed = error.code === "invalid-input" && networkCalls === 0;
    }
    results.push({ test: name, passed });
  }
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue("not bytes");
    },
    cancel() {
      cancelled = true;
    },
  });
  let streamPassed = false;
  try {
    await client.sendDocument({
      conversationId: "42",
      document: { data: stream, name: "synthetic.txt" },
    });
  } catch (error) {
    streamPassed =
      error.code === "invalid-input" &&
      cancelled &&
      !stream.locked &&
      networkCalls === 0;
  }
  results.push({
    test: "malformed upload stream cancelled",
    passed: streamPassed,
  });
  return {
    mode: "synthetic",
    passed: results.every((result) => result.passed),
    networkCalls,
    results,
  };
}
