import { createRoot } from "react-dom/client";
import Page from "./Page";

// Module-level side effect: only runs again if this MODULE (main.tsx) is
// re-evaluated, which only happens on a full page reload (main.tsx is never
// the file the "canvas" rewrites, so it should be a reliable full-reload
// detector: unchanged value => hot update, changed value => full reload).
declare global {
  interface Window {
    __marker?: number;
  }
}
window.__marker = Date.now();

const container = document.getElementById("root")!;
const root = createRoot(container);
root.render(<Page />);
