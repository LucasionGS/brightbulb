/**
 * BrightBulb main process entry.
 */
import { app } from "electron";
import App from "./App";
import { registerIpc } from "./ipc";
import Paths from "./paths";
import { closePortalCapture, openPortalCapture } from "./PortalWindow";
import Secrets from "./Secrets";
import { createTray, refreshTray } from "./tray";
import { createMainWindow, quitApp, showWindow } from "./window";

if (process.env.BRIGHTBULB_DEBUG) {
  app.commandLine.appendSwitch("enable-logging");
  // Lets DevTools (chrome://inspect) attach to the windows.
  app.commandLine.appendSwitch("remote-debugging-port", process.env.BRIGHTBULB_DEBUG_PORT ?? "9229");
}

// Chromium's own caches stay out of ~/.config/brightbulb, which only holds
// settings.json and the encrypted secrets.
app.setPath("userData", Paths.cache);
app.setPath("sessionData", Paths.cache);
Secrets.configureBackend();

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    App.init();
    registerIpc();

    App.syncHost.on("portalRequest", (width, height, fps) => openPortalCapture(width, height, fps));
    App.syncHost.on("portalRelease", () => closePortalCapture());

    App.window = createMainWindow();
    App.window.on("show", () => refreshTray());
    App.window.on("hide", () => refreshTray());
    App.window.webContents.once("did-finish-load", () => App.publish());
    createTray();
  });

  // The window decides between hiding and quitting; nothing else quits implicitly.
  app.on("window-all-closed", () => { /* Kept alive by the tray */ });

  app.on("before-quit", (event) => {
    if (App.quitting) return;
    event.preventDefault();
    void quitApp();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void quitApp());
  }
}
