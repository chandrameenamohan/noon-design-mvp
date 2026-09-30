/**
 * Colours for other people's names, cursors and selections. A LIST, not a formula: every entry was
 * checked to read as text on white and as a background for white text (WCAG AA, 4.5:1;
 * colour.test.ts recomputes it). The first version derived hsl(hue 70% 35%) from the id, and a third
 * of the hue wheel (yellow through cyan) came out at about 3:1.
 */
export const PRESENCE_COLOURS = ["#b42318", "#9a3412", "#7a5c00", "#276221", "#0f6b63", "#1d4ed8", "#6d28d9", "#a21caf"] as const;

// WCAG 2.x relative luminance and contrast ratio, for "#rrggbb": colour.test.ts checks the palette with it, theme.test.ts the tokens.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** The same connection gets the same colour in every window, because it comes from its id. */
export function colourOf(peerId: string): string {
  let hash = 0;
  for (const char of peerId) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return PRESENCE_COLOURS[hash % PRESENCE_COLOURS.length] ?? PRESENCE_COLOURS[0];
}
