import type { MiniAppClient } from "@lo-ink/miniapp-sdk";
import type { Bridge } from "./bridges.ts";
import { deferredIdentity } from "./deferred.ts";
import { bounded } from "./runner.ts";
import { createSuite } from "./suite.ts";
import {
  assertRecoveryCurrent,
  saveRecovery,
  sameOwner,
  type RecoveryTicket,
} from "./run-storage.ts";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export function recoveryPending(ticket: RecoveryTicket | null): boolean {
  return Object.values(ticket?.recovery ?? {}).some(
    (entry) => entry.written.length > 0 || entry.mutations.length > 0,
  );
}

/** Restore only recorded host resources; never execute checks or prepare fixtures. */
export async function recoverRun(
  ticket: RecoveryTicket,
  bridges: Bridge[],
  storage: Storage,
  signal: AbortSignal,
  publish: (ticket: RecoveryTicket) => void,
): Promise<RecoveryTicket> {
  signal.throwIfAborted();
  assertRecoveryCurrent(storage, ticket);
  if (!ticket.owner)
    throw new Error(
      "Владелец прежнего прогона неизвестен. Нужна ручная очистка; запись восстановления сохранена.",
    );
  for (const bridge of bridges) {
    if (!bridge.client || !ticket.recovery[bridge.id]) continue;
    const owner = deferredIdentity(bridge.client);
    if (!owner || !sameOwner(ticket, owner))
      throw new Error(
        "Восстановление доступно только в прежнем аккаунте и приложении LO.",
      );
  }
  let current = ticket;
  const controller = new AbortController();
  const cleanupSignal = AbortSignal.any([signal, controller.signal]);
  const errors: string[] = [];
  for (const [id, recovery] of Object.entries(ticket.recovery)) {
    if (!recovery.written.length && !recovery.mutations.length) continue;
    assertRecoveryCurrent(storage, current);
    cleanupSignal.throwIfAborted();
    const bridge =
      id === "native" ? bridges.find((item) => item.id === id) : undefined;
    if (!bridge?.client) {
      errors.push(
        id === "compat"
          ? "Прежний маршрут compat больше не поддерживается. Нужна ручная очистка в прежнем приложении; запись восстановления сохранена."
          : `${id}: мост недоступен`,
      );
      continue;
    }
    // Cleanup catches individual failures, so fence every host operation too.
    const client: MiniAppClient = {
      ...bridge.client,
      call: (name, input, options) => {
        assertRecoveryCurrent(storage, current);
        cleanupSignal.throwIfAborted();
        return bridge.client!.call(name, input, options);
      },
    };
    const suite = createSuite({
      runId: ticket.id,
      bridgeId: id,
      client,
      recovery,
      includeBot: false,
      consent: null,
      api: async () => {
        throw new Error("Восстановление не запускает запросы бота");
      },
      verified: () => {},
      observed: () => ({}),
      checkpoint: () => {
        try {
          current = saveRecovery(storage, current, {
            ...current.recovery,
            [id]: suite.checkpoint(),
          });
          publish(current);
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      },
    });
    try {
      await bounded(suite.cleanup.execute, cleanupSignal, 20000);
    } catch (error) {
      errors.push(
        `${id}: ${error instanceof Error ? error.message : "ошибка восстановления"}`,
      );
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
  return current;
}
