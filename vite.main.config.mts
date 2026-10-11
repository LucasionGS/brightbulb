import { defineConfig, mergeConfig, type Plugin } from "vite";
import { baseConfig } from "./vite.base.config.mts";

/**
 * node-dtls-client refuses Node's built-in AES-GCM whenever it sees Electron
 * (old Electron builds lacked AEAD ciphers) and requires the optional native
 * `node-aead-crypto` instead, via `createRequire(import.meta.url)`, which is
 * undefined in a CommonJS bundle. Electron's BoringSSL has AES-128-GCM, the
 * only suite BrightBulb negotiates, so use the built-in path and drop the
 * native fallback entirely.
 */
function nativeAeadOnElectron(): Plugin {
  return {
    name: "brightbulb:native-aead",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("node-dtls-client/build/lib/AEADCrypto.js")) return null;
      const patched = code
        .replace("const require = createRequire(import.meta.url);", "const require = () => { throw new Error(\"node-aead-crypto is not bundled\"); };")
        .replace("if (!process.versions.electron &&", "if (");
      if (patched === code) {
        throw new Error("node-dtls-client's AEADCrypto.js changed; update the brightbulb:native-aead patch in vite.main.config.mts.");
      }
      return { code: patched, map: null };
    },
  };
}

export default defineConfig(mergeConfig(baseConfig, {
  plugins: [nativeAeadOnElectron()],
  build: {
    rollupOptions: {
      external: ["node-aead-crypto"],
    },
  },
}));
