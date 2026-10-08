import {
  createMiniAppClient,
  createNativeAdapter,
  type MiniAppClient,
  type LoNativeGlobal,
} from "@lo-ink/miniapp-sdk";
export type Bridge = {
  id: string;
  label: string;
  client: MiniAppClient | null;
  native?: ReturnType<typeof createNativeAdapter>;
};
export function availableBridges(
  scope: LoNativeGlobal = globalThis as LoNativeGlobal,
): Bridge[] {
  const native = createNativeAdapter(scope);
  return [
    {
      id: "native",
      label: "Нативный мост",
      client: native ? createMiniAppClient(native) : null,
      native,
    },
  ];
}
