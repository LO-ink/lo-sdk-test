import type { Bridge } from "./bridges.ts";
import type { Interact } from "./interaction.ts";
import type { Check, CheckOutcome } from "./runner.ts";

type Scheme = "light" | "dark";
const systemScheme = (): Scheme =>
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

// One real device cycle supplies independent evidence for each bridge.
// Nothing in this test changes CSS or invents a themeChanged event.
export function systemThemeChecks(
  bridges: Bridge[],
  interact: Interact,
  readSystem: () => Scheme = systemScheme,
): Check[] {
  let run: Promise<Map<string, CheckOutcome | Error>> | undefined;
  const probe = async (signal: AbortSignal) => {
    const results = new Map<string, CheckOutcome | Error>();
    const releases: Array<() => void> = [];
    const initial = readSystem();
    const opposite: Scheme = initial === "light" ? "dark" : "light";
    const sequence = [opposite, initial];
    const observed = new Map<string, Scheme[]>();
    const read = (bridge: Bridge) =>
      bridge.client?.adapter.snapshot().colorScheme;
    try {
      const answer = await interact(
        {
          title: "Светлая и тёмная тема",
          detail: `LO должен использовать системную тему. Нажмите «Начать», затем в Пункте управления iPhone переключите оформление на ${opposite === "dark" ? "тёмное" : "светлое"} и верните ${initial === "dark" ? "тёмное" : "светлое"}. После каждого переключения возвращайтесь в LO. Проверяем события обоих мостов.`,
          actionLabel: "Начать проверку темы",
          action: async () => {
            for (const release of releases.splice(0)) release();
            results.clear();
            for (const bridge of bridges) {
              if (!bridge.client) continue;
              observed.set(bridge.id, []);
              try {
                releases.push(
                  bridge.client.on("themeChanged", () => {
                    const states = observed.get(bridge.id)!;
                    const next = sequence[states.length];
                    if (next && readSystem() === next && read(bridge) === next)
                      states.push(next);
                  }),
                );
              } catch {
                results.set(
                  bridge.id,
                  new Error("Мост не позволяет подписаться на themeChanged"),
                );
              }
            }
          },
          question: "Переключили системную тему туда и обратно?",
        },
        signal,
      );
      for (const bridge of bridges) {
        if (results.has(bridge.id)) continue;
        if (answer.decision === "skip") {
          results.set(bridge.id, {
            state: "manual",
            detail: "Смена системной темы не проверена",
          });
          continue;
        }
        const states = observed.get(bridge.id) ?? [];
        if (
          answer.decision === "no" ||
          states.length !== 2 ||
          readSystem() !== initial ||
          read(bridge) !== initial
        ) {
          results.set(
            bridge.id,
            new Error(
              `Смена темы не подтверждена: получено ${states.length} из 2 ожидаемых themeChanged с совпадающим colorScheme системы и LO`,
            ),
          );
          continue;
        }
        results.set(bridge.id, {
          state: "passed",
          evidence: "data",
          detail: `Реальные themeChanged: ${initial} → ${opposite} → ${initial}; colorScheme моста совпал с системной темой`,
        });
      }
      return results;
    } finally {
      for (const release of releases) release();
    }
  };
  return bridges.map((bridge) => ({
    id: `${bridge.id}:system-theme`,
    label: "Светлая и тёмная системная тема",
    group: `${bridge.label} · Приложение LO`,
    bridge: bridge.label,
    evidence: "data",
    timeoutMs: 180000,
    timeoutState: "manual",
    skip: () =>
      !bridge.client
        ? { state: "skipped", detail: "Этот мост недоступен" }
        : undefined,
    execute: async (signal) => {
      run ??= probe(signal);
      const result = (await run).get(bridge.id)!;
      if (result instanceof Error) throw result;
      return result;
    },
  }));
}
