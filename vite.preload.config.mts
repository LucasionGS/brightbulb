import { defineConfig, mergeConfig } from "vite";
import { baseConfig } from "./vite.base.config.mts";

export default defineConfig(mergeConfig(baseConfig, {}));
