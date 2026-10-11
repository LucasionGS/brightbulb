import type { BrightBulbApi } from "@shared/ipc";

declare global {
  interface Window {
    /**
     * The API exposed by the preload script.
     */
    bb: BrightBulbApi;
  }
}
