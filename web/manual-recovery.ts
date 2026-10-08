import type { Recovery, RunReport } from "./runner.ts";

export const lastRunKey = "sdk-test.last-run";
export const manualArchivePrefix = "sdk-test.manual-cleanup.";
const maxRecords = 20;
const maxBytes = 8 * 1024 * 1024;
export type RecoveryTicket = {
  snapshot: string;
  id: string;
  owner?: RunReport["owner"];
  startedAt: string;
  recovery: Record<string, Recovery>;
};
type Reader = Pick<Storage, "getItem">;
type ArchiveStorage = Pick<Storage, "getItem" | "setItem" | "key" | "length">;
const changed =
  "Сохранённый прогон изменился. Откройте приложение заново перед подтверждением очистки.";

// This hash is only an index. Exact snapshot equality, never hash equality,
// authorizes retirement; collisions refuse a write instead of replacing data.
export function manualArchiveKey(snapshot: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < snapshot.length; i++)
    hash = BigInt.asUintN(
      64,
      (hash ^ BigInt(snapshot.charCodeAt(i))) * 0x100000001b3n,
    );
  return `${manualArchivePrefix}${hash.toString(16)}-${snapshot.length}`;
}
function archiveMatches(raw: string | null, snapshot: string): boolean {
  if (!raw || raw.length * 2 > maxBytes) return false;
  try {
    const value = JSON.parse(raw);
    return (
      value?.schema === 1 &&
      value.kind === "external-cleanup-attestation" &&
      value.verified === false &&
      value.snapshot === snapshot &&
      typeof value.attestedAt === "string" &&
      Number.isFinite(Date.parse(value.attestedAt))
    );
  } catch {
    return false;
  }
}
export function isManuallyRetired(storage: Reader, snapshot: string): boolean {
  return archiveMatches(storage.getItem(manualArchiveKey(snapshot)), snapshot);
}
export function manualOnlyRecovery(ticket: RecoveryTicket): boolean {
  const pending = Object.entries(ticket.recovery).filter(
    ([, entry]) => entry.written.length || entry.mutations.length,
  );
  return (
    pending.length > 0 &&
    (!ticket.owner || pending.every(([id]) => id !== "native"))
  );
}
export function cleanupTicketExport(ticket: RecoveryTicket): string {
  return JSON.stringify(
    {
      kind: "lo-sdk-test-cleanup-ticket",
      schema: 1,
      verified: false,
      owner: ticket.owner
        ? { appId: ticket.owner.appId, userId: ticket.owner.userId }
        : null,
      runId: ticket.id,
      startedAt: ticket.startedAt,
      obligations: Object.fromEntries(
        Object.entries(ticket.recovery).map(([id, entry]) => [
          id,
          {
            key: entry.key,
            written: [...entry.written],
            mutations: [...entry.mutations],
            ...(entry.buttons ? { buttons: [...entry.buttons] } : {}),
            original: {
              isOrientationLocked: entry.original.isOrientationLocked,
              isFullscreen: entry.original.isFullscreen,
              ...(entry.original.theme
                ? {
                    theme: {
                      background: entry.original.theme.background,
                      headerBackground: entry.original.theme.headerBackground,
                      bottomBarBackground:
                        entry.original.theme.bottomBarBackground,
                    },
                  }
                : {}),
            },
          },
        ]),
      ),
    },
    null,
    2,
  );
}
/** Archive an explicit user assertion, without rewriting results or clearing debt. */
export function attestManualCleanup(
  storage: ArchiveStorage,
  ticket: RecoveryTicket,
  confirmed: boolean,
  now = new Date().toISOString(),
): void {
  if (!confirmed || !manualOnlyRecovery(ticket))
    throw new Error(
      "Подтвердите выполнение всех ручных обязательств в прежнем приложении и аккаунте.",
    );
  if (!Number.isFinite(Date.parse(now)))
    throw new Error("Недопустимое время подтверждения");
  const current = () => {
    if (storage.getItem(lastRunKey) !== ticket.snapshot)
      throw new Error(changed);
  };
  current();
  const original = JSON.parse(ticket.snapshot)?.report;
  if (
    !original ||
    original.id !== ticket.id ||
    original.startedAt !== ticket.startedAt ||
    JSON.stringify(original.owner) !== JSON.stringify(ticket.owner) ||
    JSON.stringify(original.recovery) !== JSON.stringify(ticket.recovery)
  )
    throw new Error(changed);
  const key = manualArchiveKey(ticket.snapshot);
  const existing = storage.getItem(key);
  if (existing !== null) {
    if (!archiveMatches(existing, ticket.snapshot))
      throw new Error(
        "Архив очистки уже занят другой записью. Исходные данные сохранены.",
      );
    current();
    return;
  }
  const value = JSON.stringify({
    schema: 1,
    kind: "external-cleanup-attestation",
    verified: false,
    attestedAt: now,
    snapshot: ticket.snapshot,
  });
  let count = 0,
    bytes = (key.length + value.length) * 2;
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index);
    if (!name?.startsWith(manualArchivePrefix)) continue;
    const raw = storage.getItem(name);
    if (raw === null) continue;
    count++;
    bytes += (name.length + raw.length) * 2;
  }
  if (count >= maxRecords || bytes > maxBytes)
    throw new Error(
      "Архив ручной очистки заполнен. Старые записи и текущие обязательства сохранены; обратитесь к разработчику стенда.",
    );
  current();
  if (storage.getItem(key) !== null) throw new Error(changed);
  // Separate immutable keys preserve sibling archives. These optimistic checks
  // do not make localStorage an atomic cross-tab transaction.
  storage.setItem(key, value);
  if (storage.getItem(key) !== value)
    throw new Error("Не удалось подтвердить сохранение архива очистки.");
  current();
}
