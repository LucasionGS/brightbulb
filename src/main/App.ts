/**
 * App-wide state and services for the main process.
 *
 * Owns the bridge connection, light writer, sync controller and pairing flow,
 * and publishes one coalesced `AppSnapshot` to the renderer whenever any of
 * them changes.
 */
import { app, nativeImage, type BrowserWindow } from "electron";
import { bridgeDisplayName } from "@shared/bridgeId";
import type { AppSnapshot, BridgeCandidate, CaptureVM } from "@shared/ipc";
import BridgeConnection from "./hue/BridgeConnection";
import LightWriter from "./hue/LightWriter";
import PairingController from "./hue/PairingController";
import { selectAreas, selectRooms, selectSceneGroups } from "./hue/selectors";
import Secrets, { type BridgeCredentials } from "./Secrets";
import Settings from "./Settings";
import SyncController from "./sync/SyncController";
import SyncHost from "./sync/SyncHost";
import DBus from "./dbus";
import ICON_64 from "../../assets/icon-64.png?inline";
import ICON_256 from "../../assets/icon-256.png?inline";

const PUBLISH_INTERVAL = 33;
const TRAY_POLL_INTERVAL = 10000;

export class App {
  public static connection: BridgeConnection;
  public static writer: LightWriter;
  public static syncHost: SyncHost;
  public static sync: SyncController;
  public static pairing: PairingController;
  public static window: BrowserWindow | null = null;
  public static quitting = false;

  /**
   * Window icon. Created on first use, since images need the app to be ready.
   */
  public static get icon(): Electron.NativeImage {
    return this._icon ??= nativeImage.createFromDataURL(ICON_256);
  }

  public static get trayIcon(): Electron.NativeImage {
    return this._trayIcon ??= nativeImage.createFromDataURL(ICON_64);
  }

  private static _icon: Electron.NativeImage | null = null;
  private static _trayIcon: Electron.NativeImage | null = null;

  private static _rev = 0;
  private static _publishTimer: NodeJS.Timeout | null = null;
  private static _capture: CaptureVM = { backends: [], detected: null };
  private static _trayAvailable = false;
  private static _listeners: (() => void)[] = [];

  private constructor() { }

  /**
   * Create services and wire their events. Call once after `ready`.
   */
  public static init(): void {
    Settings.load();
    Secrets.load();

    this.connection = new BridgeConnection();
    this.writer = new LightWriter(() => this.connection.client);
    this.syncHost = new SyncHost();
    this.sync = new SyncController(this.connection, this.syncHost);
    this.pairing = new PairingController();

    this.connection.on("state", () => this.publish());
    this.connection.on("changed", () => this.publish());
    this.connection.on("pinned", (fingerprint) => {
      Settings.data.bridgeCertSha256 = fingerprint;
      Settings.save();
    });
    this.sync.on("changed", () => this.publish());
    this.pairing.on("changed", () => this.publish());
    this.pairing.on("paired", (candidate, credentials, fingerprint) => void this._onPaired(candidate, credentials, fingerprint));

    void this.refreshCapture();
    void this._pollTray();
    setInterval(() => void this._pollTray(), TRAY_POLL_INTERVAL);

    this.connectBridge();
  }

  /**
   * Subscribe to every publish, e.g. to refresh the tray menu.
   */
  public static onPublish(listener: () => void): void {
    this._listeners.push(listener);
  }

  /**
   * Connect to the stored bridge, if there is one.
   */
  public static connectBridge(): void {
    const { bridgeId, bridgeHost, bridgeCertSha256 } = Settings.data;
    if (!bridgeId || !bridgeHost) {
      this.connection.disconnect();
      return;
    }
    void Secrets.get(bridgeId).then((credentials) => {
      if (!credentials) {
        this.connection.disconnect(Secrets.locked
          ? "The keyring is locked, so the bridge credentials cannot be read. Unlock it and reconnect."
          : "No stored credentials for this bridge. Pair with it again.");
        return;
      }
      this.connection.connect({ bridgeId, host: bridgeHost, appKey: credentials.appKey, pin: bridgeCertSha256 });
    });
  }

  /**
   * Forget the paired bridge entirely.
   */
  public static async forgetBridge(): Promise<void> {
    await this.sync.stop();
    const id = Settings.data.bridgeId;
    if (id) await Secrets.clear(id);
    Settings.data.bridgeId = null;
    Settings.data.bridgeHost = null;
    Settings.data.bridgeCertSha256 = null;
    await Settings.flush();
    this.connection.disconnect();
    this.writer.clear();
  }

  /**
   * Accept whatever certificate the bridge presents now. The connection still
   * checks that the bridge id matches the paired one.
   */
  public static retrustCertificate(): void {
    Settings.data.bridgeCertSha256 = null;
    Settings.save();
    this.connectBridge();
  }

  /**
   * Ask the sync process which capture backends work here.
   */
  public static async refreshCapture(): Promise<void> {
    const reply = await this.syncHost.request({ type: "detect" });
    if (reply.ok) {
      this._capture = reply.value as CaptureVM;
      this.publish();
    }
  }

  public static get trayAvailable(): boolean {
    return this._trayAvailable;
  }

  private static async _pollTray(): Promise<void> {
    const available = await DBus.nameHasOwner("org.kde.StatusNotifierWatcher");
    if (available !== this._trayAvailable) {
      this._trayAvailable = available;
      this.publish();
    }
  }

  private static async _onPaired(candidate: BridgeCandidate, credentials: BridgeCredentials, fingerprint: string | null): Promise<void> {
    try {
      await Secrets.set(candidate.bridgeId, credentials);
    } catch (error) {
      console.error("Could not store bridge credentials:", error);
    }
    if (Settings.data.bridgeId !== candidate.bridgeId) {
      // Areas belong to a bridge; a stale id would only confuse the picker.
      Settings.data.sync.entertainmentId = null;
    }
    Settings.data.bridgeId = candidate.bridgeId;
    Settings.data.bridgeHost = candidate.host;
    Settings.data.bridgeCertSha256 = fingerprint;
    await Settings.flush();
    this.connectBridge();
  }

  /**
   * Schedule a snapshot push to the renderer.
   */
  public static publish(): void {
    if (this._publishTimer) return;
    this._publishTimer = setTimeout(() => {
      this._publishTimer = null;
      const snapshot = this.snapshot();
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send("app:snapshot", snapshot);
      }
      for (const listener of this._listeners) listener();
    }, PUBLISH_INTERVAL);
  }

  public static snapshot(): AppSnapshot {
    const store = this.connection.store;
    const target = this.connection.target;
    return {
      rev: ++this._rev,
      version: app.getVersion(),
      connection: {
        state: this.connection.state,
        detail: this.connection.detail,
        code: this.connection.code,
        bridge: target ? { id: target.bridgeId, host: target.host, name: bridgeDisplayName(target.bridgeId) } : null,
      },
      pairing: this.pairing.vm,
      rooms: selectRooms(store),
      sceneGroups: selectSceneGroups(store),
      areas: selectAreas(store),
      sync: this.sync.vm,
      capture: this._capture,
      settings: { closeToTray: Settings.data.closeToTray },
      tray: { available: this._trayAvailable },
      secrets: { backend: Secrets.backend, insecure: Secrets.insecure, locked: Secrets.locked },
    };
  }
}

export default App;
