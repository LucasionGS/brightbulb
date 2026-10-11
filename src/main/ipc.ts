import { app, ipcMain, MessageChannelMain, nativeImage, type IpcMainInvokeEvent } from "electron";
import { failure, success, type BridgeCandidate, type InvokeChannels, type LightCommand, type GroupCommand, type Monitor, type Result, type SyncOptions } from "@shared/ipc";
import { CAPTURE_BACKEND_IDS, LIMITS, type CaptureBackendId } from "@shared/settingsCodec";
import type { Thumbnail } from "@shared/syncMessages";
import App from "./App";
import Settings from "./Settings";
import { hideToTray, quitApp } from "./window";

const THUMBNAIL_SIZE = { WIDTH: 320, HEIGHT: 180 };

/**
 * Only the app's own pages may call in.
 */
function isTrusted(event: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return !!App.window && event.sender === App.window.webContents;
}

function handle<K extends keyof InvokeChannels>(
  channel: K,
  handler: (arg: InvokeChannels[K][0]) => Promise<InvokeChannels[K][1]> | InvokeChannels[K][1],
): void {
  ipcMain.handle(channel, async (event, arg) => {
    if (!isTrusted(event)) return failure("forbidden", "Not allowed.");
    try {
      return await handler(arg);
    } catch (error) {
      console.error(`${channel} failed:`, error);
      return failure("error", error instanceof Error ? error.message : String(error));
    }
  });
}

/**
 * Run an action and report its outcome as a Result.
 */
async function attempt(action: () => unknown): Promise<Result> {
  try {
    await action();
    return success(undefined);
  } catch (error) {
    return failure("error", (error as Error).message);
  }
}

//#region Validation
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 256;
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inRange = (v: unknown, min: number, max: number): v is number => isNumber(v) && v >= min && v <= max;

function isCandidate(v: unknown): v is BridgeCandidate {
  const c = v as BridgeCandidate;
  return !!c && isString(c.host) && isString(c.bridgeId) && typeof c.supportsV2 === "boolean";
}

function validLight(v: unknown): LightCommand | null {
  const c = v as LightCommand;
  if (!c || !isString(c.id)) return null;
  if (c.on !== undefined && typeof c.on !== "boolean") return null;
  if (c.brightness !== undefined && !inRange(c.brightness, 0, 100)) return null;
  if (c.mirek !== undefined && !inRange(c.mirek, 100, 1000)) return null;
  if (c.xy !== undefined && !(Array.isArray(c.xy) && c.xy.length === 2 && inRange(c.xy[0], 0, 1) && inRange(c.xy[1], 0, 1))) return null;
  return { id: c.id, on: c.on, brightness: c.brightness, mirek: c.mirek, xy: c.xy };
}

function validGroup(v: unknown): GroupCommand | null {
  const c = v as GroupCommand;
  if (!c || !isString(c.groupedLightId)) return null;
  if (c.on !== undefined && typeof c.on !== "boolean") return null;
  if (c.brightness !== undefined && !inRange(c.brightness, 0, 100)) return null;
  return { groupedLightId: c.groupedLightId, on: c.on, brightness: c.brightness };
}

function validSyncOptions(v: unknown): Partial<SyncOptions> | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Partial<SyncOptions>;
  const out: Partial<SyncOptions> = {};
  if (o.brightness !== undefined) {
    if (!inRange(o.brightness, LIMITS.BRIGHTNESS.MIN, LIMITS.BRIGHTNESS.MAX)) return null;
    out.brightness = o.brightness;
  }
  if (o.saturation !== undefined) {
    if (!inRange(o.saturation, LIMITS.SATURATION.MIN, LIMITS.SATURATION.MAX)) return null;
    out.saturation = o.saturation;
  }
  if (o.smoothing !== undefined) {
    if (!inRange(o.smoothing, 0, 0.95)) return null;
    out.smoothing = o.smoothing;
  }
  if (o.screenAtPositiveY !== undefined) {
    if (typeof o.screenAtPositiveY !== "boolean") return null;
    out.screenAtPositiveY = o.screenAtPositiveY;
  }
  if (o.fps !== undefined) {
    if (!inRange(o.fps, LIMITS.FPS.MIN, LIMITS.FPS.MAX)) return null;
    out.fps = Math.round(o.fps);
  }
  if (o.backend !== undefined) {
    if (o.backend !== "auto" && !CAPTURE_BACKEND_IDS.includes(o.backend)) return null;
    out.backend = o.backend;
  }
  if (o.monitor !== undefined) {
    if (o.monitor !== null && !isString(o.monitor)) return null;
    out.monitor = o.monitor;
  }
  return out;
}
//#endregion

/**
 * The backend whose monitors the picker should show.
 */
function pickerBackend(): CaptureBackendId | null {
  const choice = Settings.data.sync.captureBackend;
  return choice === "auto" ? App.snapshot().capture.detected : choice;
}

export function registerIpc(): void {
  handle("app:getSnapshot", () => App.snapshot());

  //#region Discovery and pairing
  handle("discovery:start", () => {
    void App.pairing.search();
    return success(undefined);
  });
  handle("discovery:probe", async (host) => {
    if (!isString(host)) return failure("invalid", "Enter the bridge's IP address.");
    try {
      return success(await App.pairing.probe(host));
    } catch (error) {
      return failure("not-found", (error as Error).message);
    }
  });
  handle("pairing:start", (candidate) => {
    if (!isCandidate(candidate)) return failure("invalid", "Pick a bridge first.");
    if (!candidate.supportsV2) return failure("unsupported", "BrightBulb needs a square (v2) Hue bridge.");
    void App.pairing.pair(candidate);
    return success(undefined);
  });
  handle("pairing:cancel", () => {
    App.pairing.cancel();
    return success(undefined);
  });
  //#endregion

  //#region Bridge
  handle("bridge:forget", () => attempt(() => App.forgetBridge()));
  handle("bridge:retrustCert", () => attempt(() => App.retrustCertificate()));
  handle("bridge:reconnect", () => attempt(() => App.connectBridge()));
  //#endregion

  //#region Lights and scenes
  ipcMain.on("light:set", (event, payload) => {
    const cmd = isTrusted(event) ? validLight(payload) : null;
    if (cmd) App.writer.setLight(cmd);
  });
  ipcMain.on("group:set", (event, payload) => {
    const cmd = isTrusted(event) ? validGroup(payload) : null;
    if (cmd) App.writer.setGroup(cmd);
  });
  handle("scene:recall", async (id) => {
    if (!isString(id)) return failure("invalid", "Unknown scene.");
    const client = App.connection.client;
    if (!client) return failure("offline", "Not connected to the bridge.");
    return attempt(() => client.put("scene", id, { recall: { action: "active" } }));
  });
  //#endregion

  //#region Sync
  handle("sync:start", () => attempt(() => App.sync.start()));
  handle("sync:stop", () => attempt(() => App.sync.stop()));
  handle("sync:setArea", (id) => {
    if (!isString(id)) return failure("invalid", "Unknown entertainment area.");
    return attempt(() => App.sync.setArea(id));
  });
  handle("sync:setOptions", (options) => {
    const valid = validSyncOptions(options);
    if (!valid) return failure("invalid", "Invalid mirroring options.");
    const backendChanged = valid.backend !== undefined && valid.backend !== Settings.data.sync.captureBackend;
    if (backendChanged) Settings.data.sync.monitor = null; // Monitor names differ between backends
    return attempt(() => App.sync.setOptions(valid));
  });
  //#endregion

  //#region Capture
  handle("capture:listMonitors", async () => {
    const backend = pickerBackend();
    if (!backend) return success<Monitor[]>([]);
    const reply = await App.syncHost.request({ type: "listMonitors", backend });
    return reply.ok ? success(reply.value as Monitor[]) : failure(reply.code, reply.message);
  });
  handle("capture:thumbnails", async (ids) => {
    const backend = pickerBackend();
    if (!backend || !Array.isArray(ids) || !ids.every(isString)) return success<{ id: string; dataUrl: string }[]>([]);
    const reply = await App.syncHost.request({ type: "thumbnails", backend, ids, width: THUMBNAIL_SIZE.WIDTH, height: THUMBNAIL_SIZE.HEIGHT }, 30000);
    if (!reply.ok) return failure(reply.code, reply.message);
    return success((reply.value as Thumbnail[]).map((t) => ({
      id: t.id,
      dataUrl: nativeImage.createFromBitmap(Buffer.from(t.bgra), { width: t.width, height: t.height }).toDataURL(),
    })));
  });
  handle("preview:enable", (enabled) => {
    if (enabled) {
      const { port1, port2 } = new MessageChannelMain();
      App.syncHost.post({ type: "preview", enabled: true }, [port1]);
      App.window?.webContents.postMessage("preview-port", null, [port2]);
    }
    else {
      App.syncHost.post({ type: "preview", enabled: false });
    }
    return success(undefined);
  });
  //#endregion

  //#region App and window
  handle("settings:set", (patch) => {
    if (typeof patch?.closeToTray === "boolean") {
      Settings.data.closeToTray = patch.closeToTray;
      Settings.save();
      App.publish();
    }
    return success(undefined);
  });
  handle("window:hideToTray", () => {
    if (!App.window || !hideToTray(App.window)) return failure("no-tray", "No system tray is running to minimize into.");
    return success(undefined);
  });
  handle("window:minimize", () => {
    App.window?.minimize();
    return success(undefined);
  });
  handle("window:toggleMaximize", () => {
    if (App.window?.isMaximized()) App.window.unmaximize();
    else App.window?.maximize();
    return success(undefined);
  });
  handle("window:close", () => {
    App.window?.close();
    return success(undefined);
  });
  handle("app:quit", () => {
    void quitApp();
    return success(undefined);
  });
  //#endregion

  app.on("web-contents-created", (_event, contents) => {
    // No page should ever create further windows or webviews.
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}
