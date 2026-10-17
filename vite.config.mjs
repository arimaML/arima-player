import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// Plain .mjs (not .ts) on purpose: Vite loads this config with
// `--configLoader native`, so Node imports it directly instead of bundling it.
// That avoids rolldown trying to inline native addons such as
// @tailwindcss/oxide, and keeps config loading working on any Node >= 20.19.
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Tauri prints its own diagnostics; don't wipe them.
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Rust sources are rebuilt by cargo, not Vite.
      ignored: ["**/src-tauri/**"],
    },
  },

  envPrefix: ["VITE_", "TAURI_ENV_*"],

  build: {
    // Tauri 2 ships WebView2 (Chromium) on Windows.
    target: "chrome105",
    // Vite 8 defaults to the oxc minifier; `esbuild` would need a separate install.
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
