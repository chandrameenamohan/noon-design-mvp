import { useEffect, useState, useSyncExternalStore } from "react";
import { readPreference, resolveTheme, THEME_KEY, toggled, type Theme, type ThemePreference } from "./theme.ts";

// localStorage can be absent or refuse (a private window, site data blocked): then nothing is remembered, and the page still works.
const remembered = (): ThemePreference => { try { return readPreference(localStorage.getItem(THEME_KEY)); } catch { return "system"; } };
const remember = (theme: Theme): void => { try { localStorage.setItem(THEME_KEY, theme); } catch { /* not remembered; the choice still holds until the tab closes */ } };

const query = (): MediaQueryList | undefined => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined);
const systemDark = (): boolean => query()?.matches ?? false;
const onSystemChange = (listener: () => void): (() => void) => {
  const media = query();
  media?.addEventListener("change", listener);
  return () => { media?.removeEventListener("change", listener); };
};

/** The RESOLVED theme goes on <html data-theme>; tokens.css keys the dark tokens on it. */
const apply = (theme: Theme): void => { document.documentElement.dataset["theme"] = theme; };

/** Called once before the first render (main.tsx), so the first paint is already in the right theme. */
export function applyStoredTheme(): void { apply(resolveTheme(remembered(), systemDark())); }

/**
 * The theme the page shows, and a toggle that overrides the OS and is remembered per browser. The OS
 * preference is an external store (a matchMedia change is not a render): useSyncExternalStore, as usePeer.ts does.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [preference, setPreference] = useState<ThemePreference>(remembered);
  const dark = useSyncExternalStore(onSystemChange, systemDark, () => false);
  const theme = resolveTheme(preference, dark);
  useEffect(() => { apply(theme); }, [theme]);
  return {
    theme,
    toggle: () => { const next = toggled(theme); remember(next); setPreference(next); },
  };
}
