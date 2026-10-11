import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "brightbulb",
  },
  rebuildConfig: {},
  // Distributed as an app.asar run by the system Electron (see Makefile and the
  // AUR PKGBUILD), so no installer makers are needed.
  makers: [],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/main.ts", config: "vite.main.config.mts", target: "main" },
        // The streaming engine runs in its own utilityProcess; see src/sync/syncWorker.ts.
        { entry: "src/sync/syncWorker.ts", config: "vite.main.config.mts", target: "main" },
        { entry: "src/preload/preload.ts", config: "vite.preload.config.mts", target: "preload" },
        { entry: "src/preload/capturePreload.ts", config: "vite.preload.config.mts", target: "preload" },
      ],
      renderer: [
        { name: "main_window", config: "vite.renderer.config.mts" },
        { name: "capture_window", config: "vite.capture.config.mts" },
      ],
    }),
  ],
};

export default config;
