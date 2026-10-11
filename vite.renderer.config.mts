import Path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import react from "@vitejs/plugin-react";
import { baseConfig } from "./vite.base.config.mts";

export default defineConfig(mergeConfig(baseConfig, {
  root: "src/renderer",
  plugins: [react()],
  build: {
    // Forge resolves its default outDir against `root`, which is not the repo root here.
    outDir: Path.resolve(import.meta.dirname, ".vite/renderer/main_window"),
  },
}));
