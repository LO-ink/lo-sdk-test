/**
 * LO's palette, and how a host's theme overrides it.
 *
 * The defaults are LO's own tokens (`theme/v2/colors` in the LO app), so the
 * mini app looks like LO before any host says a word. A host that does send
 * `themeParams` wins — that is the whole point of the contract.
 */
export type Provider = "telegram" | "lo";
export type Scheme = "light" | "dark";
export type ThemeParams = Record<string, string | undefined>;

const lo = {
  light: {
    page: "#F9FCFF",
    surface: "#FFFFFF",
    ink: "#121624",
    muted: "#90959E",
    accent: "#5969FC",
    accentInk: "#FAFAF9",
    error: "#EA5455",
    success: "#257B52",
    bar: "#FFFFFF",
  },
  dark: {
    page: "#161D31",
    surface: "#21283E",
    ink: "#D0D2D6",
    muted: "#90959E",
    accent: "#5969FC",
    accentInk: "#FAFAF9",
    error: "#EA5455",
    success: "#6BC799",
    bar: "#121624",
  },
} as const;

function hex(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return /^#[0-9a-f]{3}$|^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/i.test(text)
    ? text
    : undefined;
}

/**
 * LO uses `bg_color` for the page and `secondary_bg_color` for cards. The
 * compatibility bridge uses a different mapping, so colours are resolved
 * according to the bridge rather than the parameter name alone.
 */
export function palette(
  provider: Provider,
  scheme: Scheme,
  params: ThemeParams = {},
): Record<string, string> {
  const base = lo[scheme];
  const page =
    provider === "lo" ? hex(params.bg_color) : hex(params.secondary_bg_color);
  const surface =
    provider === "lo"
      ? hex(params.secondary_bg_color)
      : (hex(params.section_bg_color) ?? hex(params.bg_color));
  return {
    "--page": page ?? base.page,
    "--surface": surface ?? base.surface,
    "--ink": hex(params.text_color) ?? base.ink,
    "--muted": hex(params.hint_color) ?? base.muted,
    "--accent":
      hex(params.button_color) ?? hex(params.link_color) ?? base.accent,
    "--accent-ink": hex(params.button_text_color) ?? base.accentInk,
    "--error": hex(params.destructive_text_color) ?? base.error,
    "--success": base.success,
    "--bar": hex(params.bottom_bar_bg_color) ?? base.bar,
  };
}

export function applyPalette(
  root: { style: { setProperty(name: string, value: string): void } },
  provider: Provider,
  scheme: Scheme,
  params?: ThemeParams,
): void {
  const values = palette(provider, scheme, params);
  for (const name of Object.keys(values))
    root.style.setProperty(name, values[name]);
}
