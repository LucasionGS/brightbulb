import fs from "node:fs";
import fsp from "node:fs/promises";
import Path from "node:path";
import { execFile } from "node:child_process";
import { app, safeStorage } from "electron";
import DBus from "./dbus";
import Paths from "./paths";

/**
 * Credentials a bridge issued at pairing time.
 * `appKey` authenticates CLIP requests and doubles as the DTLS PSK identity;
 * `clientKey` is the hex-encoded PSK itself and cannot be recovered later.
 */
export interface BridgeCredentials {
  appKey: string;
  clientKey: string;
}

/**
 * Per-bridge credentials, kept in one blob encrypted with Electron's
 * `safeStorage` (libsecret or KWallet underneath).
 */
export class Secrets {
  private static _data: Record<string, BridgeCredentials> = {};
  private static _locked = false;

  private constructor() { }

  /**
   * Pick the password store before Electron is ready.
   * Chromium only recognises GNOME and KDE desktops; on Hyprland or Sway it
   * silently falls back to `basic_text`, which "encrypts" with a hardcoded key.
   * If a Secret Service is running, use it.
   */
  public static configureBackend(): void {
    if (process.platform !== "linux") return;
    if (app.commandLine.hasSwitch("password-store")) return;
    if (DBus.nameHasOwnerSync("org.freedesktop.secrets")) {
      app.commandLine.appendSwitch("password-store", "gnome-libsecret");
    }
  }

  /**
   * The storage backend in use, as Chromium names it (`gnome_libsecret`, `basic_text`…).
   */
  public static get backend(): string {
    if (process.platform !== "linux") return "os";
    try {
      return safeStorage.getSelectedStorageBackend();
    } catch {
      return "unknown";
    }
  }

  /**
   * True when secrets are stored without real encryption.
   */
  public static get insecure(): boolean {
    return this.backend === "basic_text" || !safeStorage.isEncryptionAvailable();
  }

  /**
   * True when a blob exists but could not be decrypted, for example because
   * the keyring was still locked. Nothing is written while locked.
   */
  public static get locked(): boolean {
    return this._locked;
  }

  /**
   * Read and decrypt the secrets blob. Call after `ready`.
   */
  public static load(): void {
    this._locked = false;
    let blob: Buffer;
    try {
      blob = fs.readFileSync(Paths.secretsFile);
    } catch {
      this._data = {};
      return;
    }
    try {
      const parsed = JSON.parse(safeStorage.decryptString(blob));
      this._data = typeof parsed === "object" && parsed ? parsed : {};
    } catch (error) {
      // Most likely written through libsecret but this session only has
      // basic_text (autostart before the keyring daemon). Overwriting would
      // destroy the client key for good, so stay locked instead.
      console.warn("Could not decrypt secrets; keyring locked or unavailable:", error);
      this._data = {};
      this._locked = true;
    }
  }

  /**
   * Credentials for a bridge, migrating them from v1's storage on first use.
   */
  public static async get(bridgeId: string): Promise<BridgeCredentials | null> {
    if (this._data[bridgeId]) return this._data[bridgeId];
    if (this._locked) return null;
    const migrated = await this._fromV1(bridgeId);
    if (migrated) {
      await this.set(bridgeId, migrated);
    }
    return migrated;
  }

  public static async set(bridgeId: string, credentials: BridgeCredentials): Promise<void> {
    if (this._locked) {
      throw new Error("The keyring is locked, so the bridge credentials cannot be saved. Unlock it and try again.");
    }
    this._data[bridgeId] = credentials;
    await this._write();
  }

  public static async clear(bridgeId: string): Promise<void> {
    if (this._locked || !this._data[bridgeId]) return;
    delete this._data[bridgeId];
    await this._write();
  }

  private static async _write(): Promise<void> {
    const blob = safeStorage.encryptString(JSON.stringify(this._data));
    await fsp.mkdir(Path.dirname(Paths.secretsFile), { recursive: true });
    const tmp = `${Paths.secretsFile}.tmp`;
    await fsp.writeFile(tmp, blob, { mode: 0o600 });
    await fsp.rename(tmp, Paths.secretsFile);
  }

  /**
   * v1 stored keys in libsecret, or in a 0600 JSON file when no keyring ran.
   * Neither is deleted, so going back to v1 keeps working.
   */
  private static async _fromV1(bridgeId: string): Promise<BridgeCredentials | null> {
    try {
      const file = JSON.parse(await fsp.readFile(Paths.v1CredentialsFile, "utf8"));
      const entry = file?.[bridgeId];
      if (entry?.app_key && entry?.client_key) {
        return { appKey: entry.app_key, clientKey: entry.client_key };
      }
    } catch {
      // No v1 file; try the keyring.
    }
    const appKey = await secretToolLookup(bridgeId, "app_key");
    const clientKey = appKey ? await secretToolLookup(bridgeId, "client_key") : null;
    return appKey && clientKey ? { appKey, clientKey } : null;
  }
}

function secretToolLookup(bridgeId: string, kind: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("secret-tool", ["lookup", "bridge_id", bridgeId, "kind", kind], { timeout: 3000 }, (error, stdout) => {
      resolve(!error && stdout.trim() ? stdout.trim() : null);
    });
  });
}

export default Secrets;
