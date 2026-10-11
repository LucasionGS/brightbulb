import Path from "node:path";
import { BrowserWindow, desktopCapturer, MessageChannelMain, session } from "electron";
import App from "./App";

let window: BrowserWindow | null = null;

/**
 * Open the hidden window that captures the screen through the portal and
 * streams downscaled frames straight to the sync process.
 */
export function openPortalCapture(width: number, height: number, fps: number): void {
  closePortalCapture();

  const captureSession = session.fromPartition("capture");
  captureSession.setDisplayMediaRequestHandler((_request, callback) => {
    // On Wayland this opens the system's screen picker.
    desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
      callback(sources[0] ? { video: sources[0] } : {});
    }).catch(() => callback({}));
  }, { useSystemPicker: true });

  window = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    webPreferences: {
      preload: Path.join(__dirname, "capturePreload.cjs"),
      contextIsolation: true,
      sandbox: true,
      session: captureSession,
      // Hidden windows are throttled by default, which would starve capture.
      backgroundThrottling: false,
    },
  });

  const { port1, port2 } = new MessageChannelMain();
  App.syncHost.post({ type: "portalPort" }, [port1]);
  window.webContents.once("did-finish-load", () => {
    window?.webContents.postMessage("capture-port", { width, height, fps }, [port2]);
  });

  if (CAPTURE_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(CAPTURE_WINDOW_VITE_DEV_SERVER_URL);
  }
  else {
    void window.loadFile(Path.join(__dirname, `../renderer/${CAPTURE_WINDOW_VITE_NAME}/index.html`));
  }
}

export function closePortalCapture(): void {
  if (window && !window.isDestroyed()) window.destroy();
  window = null;
}
