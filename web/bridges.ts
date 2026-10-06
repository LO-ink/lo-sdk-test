import { createMiniAppClient, type MiniAppClient } from "@lo-ink/miniapp-sdk";
import {
  createAdapter,
  createNativeAdapter,
  type LoGlobal,
} from "@lo-ink/adapter-lo-legacy";
export type Bridge = {
  id: string;
  label: string;
  client: MiniAppClient | null;
  native?: ReturnType<typeof createNativeAdapter>;
  panelExpanded?: () => boolean | undefined;
};
export function availableBridges(
  scope: LoGlobal = globalThis as LoGlobal,
): Bridge[] {
  const native = createNativeAdapter(scope);
  const legacy = createAdapter({ LO: { WebApp: scope.LO?.WebApp } });
  const panelExpanded = () => {
    const state = (scope.LO?.WebApp as { isExpanded?: unknown } | undefined)
      ?.isExpanded;
    return typeof state === "boolean" ? state : undefined;
  };
  return [
    {
      id: "native",
      label: "Нативный мост",
      client: native ? createMiniAppClient(native) : null,
      native,
      panelExpanded,
    },
    {
      id: "compat",
      label: "Совместимый мост",
      panelExpanded,
      client:
        legacy && (!native || legacy.launchData === native.launchData)
          ? createMiniAppClient(legacy)
          : null,
    },
  ];
}
