/**
 * LO's palette, and how a host's theme overrides it.
 *
 * The defaults are LO's own tokens (`theme/v2/colors` in the LO app), so the
 * mini app looks like LO before any host says a word. A host that does send
 * `themeParams` wins — that is the whole point of the contract.
 */
export type Provider = "telegram" | "lo";
export type Scheme = "light" | "dark";
export type ThemePreference = "host" | Scheme;
export type ThemeParams = Record<string, string | undefined>;

const lo = {
  light: {
    page: "#F7FBFF",
    surface: "#FFFFFF",
    ink: "#121624",
    muted: "#90959E",
    accent: "#5969FC",
    accentInk: "#FFFFFF",
    error: "#B42332",
    success: "#257B52",
    bar: "#FFFFFF",
  },
  dark: {
    page: "#0B0E17",
    surface: "#111522",
    ink: "#F7FBFF",
    muted: "#90959E",
    accent: "#5969FC",
    accentInk: "#FFFFFF",
    error: "#FF8C96",
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
  const action =
    hex(params.button_color) ?? hex(params.link_color) ?? base.accent;
  const actionText = hex(params.button_text_color) ?? base.accentInk;
  const nativeWhiteLabel =
    action.toUpperCase() === "#5969FC" &&
    ["#FFFFFF", "#F7FBFF", "#FFF"].includes(actionText.toUpperCase());
  return {
    "--page": page ?? base.page,
    "--surface": surface ?? base.surface,
    "--ink": hex(params.text_color) ?? base.ink,
    "--muted": hex(params.hint_color) ?? base.muted,
    "--accent": action,
    "--accent-ink": actionText,
    "--accent-fill": nativeWhiteLabel ? "#5060E8" : action,
    "--accent-text":
      action.toUpperCase() === "#5969FC"
        ? scheme === "dark"
          ? "#91A2FF"
          : "#3F50D4"
        : (hex(params.link_color) ?? action),
    "--control-border": scheme === "dark" ? "#697486" : "#818895",
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
