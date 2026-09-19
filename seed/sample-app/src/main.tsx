import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design-system/tokens.css";
import { Showcase } from "./pages/Showcase.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");
createRoot(root).render(
  <StrictMode>
    <Showcase />
  </StrictMode>,
);
