import { Menu, Tray } from "electron";
import App from "./App";
import { quitApp, showWindow, toggleWindow, hideToTray } from "./window";

let tray: Tray | null = null;
let lastMenuKey = "";

/**
 * Create the tray icon. Electron speaks StatusNotifierItem on Linux, so it
 * shows up in Waybar, KDE and GNOME (with the AppIndicator extension).
 */
export function createTray(): void {
  tray = new Tray(App.trayIcon);
  tray.setToolTip("BrightBulb");
  tray.on("click", () => toggleWindow());
  App.onPublish(() => updateTray());
  updateTray();
}

/**
 * Rebuild the menu, but only when its contents actually changed: hosts
 * re-read the whole layout on every update.
 */
function updateTray(): void {
  if (!tray) return;
  const sync = App.sync.vm;
  const visible = !!App.window?.isVisible();
  const canMirror = App.connection.state === "connected" && sync.areaId !== null;
  const mirroring = App.sync.active;
  const tooltip = `BrightBulb — ${sync.error ?? sync.status}`;

  const key = JSON.stringify([visible, canMirror, mirroring, tooltip]);
  if (key === lastMenuKey) return;
  lastMenuKey = key;

  tray.setToolTip(tooltip);
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: visible ? "Hide Window" : "Show BrightBulb",
      click: () => (visible && App.window ? hideToTray(App.window) : showWindow()),
    },
    { type: "separator" },
    {
      label: "Mirror My Screen",
      type: "checkbox",
      checked: mirroring,
      enabled: canMirror || mirroring,
      click: () => void App.sync.toggle(),
    },
    { type: "separator" },
    { label: "Quit", click: () => void quitApp() },
  ]));
}

/**
 * Refresh the Show/Hide label after the window is shown or hidden.
 */
export function refreshTray(): void {
  updateTray();
}
