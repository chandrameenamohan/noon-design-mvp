/**
 * Which theme to show. PURE: what was remembered and what the OS prefers come in, a theme comes out;
 * useTheme.ts binds it to localStorage, matchMedia and the <html> element.
 */
export type Theme = "light" | "dark";
/** "system": nothing chosen here, follow the OS. */
export type ThemePreference = Theme | "system";

/** The localStorage key the choice is remembered under, per browser. */
export const THEME_KEY = "noon.theme";

/** What storage holds, read defensively: anything but a theme name (nothing, an old value) is "system". */
export const readPreference = (stored: string | null | undefined): ThemePreference => (stored === "light" || stored === "dark" ? stored : "system");

export const resolveTheme = (preference: ThemePreference, systemDark: boolean): Theme => (preference === "system" ? (systemDark ? "dark" : "light") : preference);

/** What the toggle remembers: the OPPOSITE of what is shown, as an explicit choice, so it holds when the OS changes its mind. */
export const toggled = (shown: Theme): Theme => (shown === "dark" ? "light" : "dark");
