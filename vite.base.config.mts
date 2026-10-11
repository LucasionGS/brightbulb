import Path from "node:path";
import type { UserConfig } from "vite";

/**
 * Settings shared by every build target.
 */
export const baseConfig: UserConfig = {
  resolve: {
    alias: {
      "@shared": Path.resolve(import.meta.dirname, "src/shared"),
    },
  },
};
