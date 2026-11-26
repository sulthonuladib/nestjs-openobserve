import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

/**
 * The frontend entrypoint, discovered by Bun from `public/index.html`.
 *
 * Mount only. Every provider lives in `public/App.tsx` (query client, MUI theme,
 * router) so the shell is one file to read top to bottom.
 *
 * The whole dashboard lives under `public/` on purpose: Bun bundles this file and
 * everything it imports **at runtime**, from the directory that ships next to the
 * compiled binary. A source tree outside `public/` would not be in the release
 * artifact, and `/` would fail to build once the repo checkout is gone.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
