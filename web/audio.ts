export type AudioStart = { state: string; error?: string };
export function beginAudio(
  context: Pick<AudioContext, "resume" | "state"> | null,
): Promise<AudioStart> {
  if (!context) return Promise.resolve({ state: "unavailable" });
  try {
    return context.resume().then(
      () => ({ state: context.state }),
      () => ({ state: context.state, error: "Web Audio заблокирован" }),
    );
  } catch {
    return Promise.resolve({
      state: context.state,
      error: "Web Audio недоступен",
    });
  }
}
