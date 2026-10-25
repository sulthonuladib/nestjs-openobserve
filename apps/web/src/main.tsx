import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

/**
 * Mount only. Every provider lives in `App.tsx` (query client, MUI theme,
 * CSS baseline, router) so the shell is one file to read top to bottom.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
