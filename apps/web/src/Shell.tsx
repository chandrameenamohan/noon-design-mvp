import { useId, type ReactNode } from "react";
import { useTheme } from "./useTheme.ts";

/**
 * Layout primitives (E10.1). The editor is Figma's arrangement over Noon's tree: a top bar, layers left,
 * canvas centre, inspector right. Later beads fill the panes (E10.2 canvas, E10.3 layers, E10.4 inspector,
 * E10.5 library, E10.8 Share); this file owns only where things GO and the theme toggle.
 * ponytail: fixed pane widths (tokens --pane-width, --inspector-width); resizable panes are out of scope for E10.
 * The one divider that moves is the preview split's (Preview.tsx, E10.7).
 */

/** Follows the OS until pressed; then the choice is remembered per browser (useTheme.ts). A toggle button, not a menu: one press, one state. */
function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return <button type="button" className="theme-toggle" aria-pressed={theme === "dark"} onClick={toggle}>Dark theme</button>;
}

/** The bar every page shares: the wordmark (a way home), what the page puts there, and the theme toggle at the end. */
export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="top-bar">
      <a href="/" className="wordmark">Noon</a>
      {children}
      <ThemeToggle />
    </header>
  );
}

/** A titled pane section: a region named by its heading, so it is a landmark a keyboard user can jump to. */
export function Panel({ title, actions, children, className }: { title: string; actions?: ReactNode; children?: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={className === undefined ? "panel" : `panel ${className}`}>
      <div className="panel-head">
        <h2 id={id}>{title}</h2>
        {actions}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/**
 * The three-pane editor. `notices` is the strip between the bar and the panes for what must be read
 * before editing on (read-only, a rejected push, a refused edit); it takes no room while empty.
 */
export function Shell({ topBar, notices, left, centre, right }: { topBar: ReactNode; notices?: ReactNode; left: ReactNode; centre: ReactNode; right: ReactNode }) {
  return (
    <div className="shell">
      {topBar}
      <div className="notices">{notices}</div>
      <main className="panes">
        <div className="pane pane-left">{left}</div>
        <div className="centre">{centre}</div>
        <div className="pane pane-right">{right}</div>
      </main>
    </div>
  );
}

/** A reading page (home, audit, usage): the same bar and tokens, one column of content. */
export function Page({ bar, children }: { bar?: ReactNode; children: ReactNode }) {
  return (
    <div className="shell">
      <TopBar>{bar}</TopBar>
      <main className="page">{children}</main>
    </div>
  );
}
