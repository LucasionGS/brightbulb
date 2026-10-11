/**
 * Exposes the typed `window.bb` API to the renderer. Nothing else from
 * Electron or Node is reachable from the page.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { BrightBulbApi, PreviewFrame } from "@shared/ipc";

const previewListeners = new Set<(frame: PreviewFrame) => void>();
let previewPort: MessagePort | null = null;

// The sync process streams preview frames over a dedicated port, so they
// never queue behind snapshots on the main IPC channel.
ipcRenderer.on("preview-port", (event) => {
  previewPort?.close();
  previewPort = event.ports[0] ?? null;
  if (!previewPort) return;
  previewPort.onmessage = (message) => {
    for (const listener of previewListeners) listener(message.data as PreviewFrame);
  };
  previewPort.start();
});

const api: BrightBulbApi = {
  invoke: (channel, ...arg) => ipcRenderer.invoke(channel, ...arg),
  send: (channel, payload) => ipcRenderer.send(channel, payload),
  on: (channel, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
  onPreview: (listener) => {
    previewListeners.add(listener);
    return () => previewListeners.delete(listener);
  },
};

contextBridge.exposeInMainWorld("bb", api);
