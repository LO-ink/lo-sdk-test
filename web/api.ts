async function responseValue<T>(response: Response): Promise<T> {
  const result = await response.json();
  if (!response.ok) {
    const pause = Number.isFinite(result.retryAfterSec)
      ? `; пауза ${result.retryAfterSec} с`
      : "";
    throw Object.assign(
      new Error(
        `${result.message ?? `Ошибка ${response.status}`}${result.code ? ` (${result.code}${pause})` : ""}`,
      ),
      { code: result.code, reason: result.reason, status: response.status },
    );
  }
  return result as T;
}
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    credentials: "same-origin",
    signal,
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", "x-sdk-test": "1" },
          body: JSON.stringify(body),
        }),
  });
  return responseValue<T>(response);
}

/** Upload bytes directly; the browser supplies the File's content length. */
export async function uploadFile<T>(
  operation: string,
  file: File,
  signal?: AbortSignal,
): Promise<T> {
  if (file.size > 50 << 20) throw new Error("Файл превышает 50 МиБ");
  const query = new URLSearchParams({
    operation,
    name: file.name,
    mime: file.type,
  });
  return responseValue<T>(
    await fetch(`/api/bot/upload?${query}`, {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: {
        "content-type": "application/octet-stream",
        "x-sdk-test": "1",
      },
      body: file,
    }),
  );
}
