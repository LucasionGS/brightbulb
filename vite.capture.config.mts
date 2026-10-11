import Path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import { baseConfig } from "./vite.base.config.mts";

// Hidden window used only by the portal capture fallback.
export default defineConfig(mergeConfig(baseConfig, {
  root: "src/capture",
  build: {
    outDir: Path.resolve(import.meta.dirname, ".vite/renderer/capture_window"),
  },
}));
