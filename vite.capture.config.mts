import Path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import { baseConfig } from "./vite.base.config.mts";

// Hidden window used only by the portal capture fallback.
export default defineConfig(mergeConfig(baseConfig, {
  root: "src/capture",
  // Each renderer needs its own dependency cache, or the two dev servers keep
  // invalidating each other's optimised deps.
  cacheDir: Path.resolve(import.meta.dirname, "node_modules/.vite/capture_window"),
  build: {
    outDir: Path.resolve(import.meta.dirname, ".vite/renderer/capture_window"),
  },
}));
