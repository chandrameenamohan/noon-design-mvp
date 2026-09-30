import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyStoredTheme } from "./useTheme.ts";
import "./tokens.css";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

applyStoredTheme(); // before the first paint: no flash of the wrong theme

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
