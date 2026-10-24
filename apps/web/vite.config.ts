import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The dashboard never talks to a second origin in development: `/api` and
    // `/health` go to the collector, everything else to Vite.
    proxy: {
      "/api": { target: "http://localhost:4320", changeOrigin: true },
      "/health": { target: "http://localhost:4320", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    // The server serves this directory through @elysiajs/static.
    sourcemap: true,
  },
});
