/**
 * Preload of the hidden portal-capture window: hands the frame port from the
 * main process to the page.
 */
import { ipcRenderer } from "electron";

ipcRenderer.on("capture-port", (event, options: { width: number; height: number; fps: number }) => {
  window.postMessage({ type: "capture-port", ...options }, "*", event.ports);
});
