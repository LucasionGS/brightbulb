import Path from "node:path";
import { defineConfig, mergeConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { baseConfig } from "./vite.base.config.mts";

/**
 * The dev server injects an inline React Refresh preamble, which the page's
 * strict CSP would block. Allow inline scripts while serving only; the built
 * app keeps `script-src 'self'`.
 */
function devCsp(): Plugin {
  return {
    name: "brightbulb:dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    },
  };
}

export default defineConfig(mergeConfig(baseConfig, {
  root: "src/renderer",
  // Each renderer needs its own dependency cache, or the two dev servers keep
  // invalidating each other's optimised deps.
  cacheDir: Path.resolve(import.meta.dirname, "node_modules/.vite/main_window"),
  plugins: [react(), devCsp()],
  optimizeDeps: {
    // Listed up front so the dev server bundles them in one go. Discovering
    // them during the first page load re-optimises mid-load, leaving the page
    // with mismatched React copies and a blank window.
    include: [
      "react",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
      "react-dom",
      "react-dom/client",
      "lucide-react",
      "@base-ui/react/alert-dialog",
      "@base-ui/react/dialog",
      "@base-ui/react/select",
      "@base-ui/react/slider",
      "@base-ui/react/switch",
    ],
  },
  build: {
    // Forge resolves its default outDir against `root`, which is not the repo root here.
    outDir: Path.resolve(import.meta.dirname, ".vite/renderer/main_window"),
  },
}));
