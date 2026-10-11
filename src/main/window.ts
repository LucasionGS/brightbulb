import Path from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, Notification, shell } from "electron";
import App from "./App";
import Settings from "./Settings";

/**
 * Create the main window. Closing it hides to the tray when that is enabled
 * and a tray host is actually running; otherwise it quits.
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 380,
    minHeight: 520,
    show: false,
    frame: false,
    backgroundColor: "#0d0f14",
    icon: App.icon,
    title: "BrightBulb",
    webPreferences: {
      preload: Path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL || process.env.BRIGHTBULB_DEBUG) {
    // Renderer problems show up in the terminal during development.
    window.webContents.on("console-message", ({ level, message, sourceId, lineNumber }) => {
      if (level !== "debug") console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
    });
    window.webContents.on("preload-error", (_event, path, error) => console.error(`[preload] ${path}:`, error));
  }

  // Links open in the browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Reloading the app's own page is fine; Vite's dev server does exactly that
  // at startup, and cancelling it leaves a half-unloaded, blank page. Anything
  // else would replace the app with an arbitrary page, so it opens in the browser.
  window.webContents.on("will-navigate", (event) => {
    if (isAppUrl(event.url)) return;
    event.preventDefault();
    if (/^https?:/.test(event.url)) void shell.openExternal(event.url);
  });

  window.on("close", (event) => {
    if (App.quitting) return;
    event.preventDefault();
    if (Settings.data.closeToTray && App.trayAvailable) {
      hideToTray(window);
    }
    else {
      void quitApp();
    }
  });

  void window.loadURL(appUrl());
  return window;
}

/**
 * Where the main window's page lives: the Vite dev server, or the bundled file.
 */
function appUrl(): string {
  return MAIN_WINDOW_VITE_DEV_SERVER_URL
    || pathToFileURL(Path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)).href;
}

/**
 * Whether `url` is the app's own page (any path on the dev server, or the bundled file).
 */
function isAppUrl(url: string): boolean {
  try {
    const target = new URL(url);
    const app = new URL(appUrl());
    return target.protocol === "file:" ? target.pathname === app.pathname : target.origin === app.origin;
  } catch {
    return false;
  }
}

/**
 * Hide the window, explaining once where it went.
 */
export function hideToTray(window: BrowserWindow): boolean {
  if (!App.trayAvailable) return false;
  window.hide();
  if (!Settings.data.trayHintShown) {
    Settings.data.trayHintShown = true;
    Settings.save();
    new Notification({
      title: "BrightBulb",
      body: "Still running in the tray. Click the tray icon to bring it back.",
      icon: App.icon,
    }).show();
  }
  return true;
}

export function showWindow(): void {
  const window = App.window;
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function toggleWindow(): void {
  const window = App.window;
  if (!window) return;
  if (window.isVisible() && window.isFocused()) {
    hideToTray(window);
  }
  else {
    showWindow();
  }
}

let quitting: Promise<void> | null = null;

/**
 * Release the entertainment area and everything else, then exit.
 * Waits at most a few seconds: a dead bridge must not keep the app alive.
 */
export function quitApp(): Promise<void> {
  if (quitting) return quitting;
  App.quitting = true;
  quitting = (async () => {
    const { app } = await import("electron");
    try {
      await Promise.race([
        App.sync.shutdown(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch (error) {
      console.warn("Error while stopping mirroring:", error);
    }
    App.syncHost.kill();
    App.writer.stop();
    App.connection.disconnect();
    try {
      Settings.flushSync();
    } catch (error) {
      console.error("Could not save settings:", error);
    }
    app.exit(0);
  })();
  return quitting;
}
