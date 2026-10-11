import { defineConfig, mergeConfig } from "vite";
import { baseConfig } from "./vite.base.config.mts";

export default defineConfig(mergeConfig(baseConfig, {
  build: {
    rollupOptions: {
      // node-dtls-client only requires this on Node versions without native
      // AES-GCM, which Electron never is. Left external so bundling ignores it.
      external: ["node-aead-crypto"],
    },
  },
}));
