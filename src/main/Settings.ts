import fs from "node:fs";
import fsp from "node:fs/promises";
import Path from "node:path";
import { decodeSettings, encodeSettings, type AppSettings, type DecodedSettings } from "@shared/settingsCodec";
import Paths from "./paths";

/**
 * App-wide settings, loaded once at startup and saved atomically.
 * Saves are debounced so dragging a slider does not rewrite the file on every
 * step; `flush()` writes immediately and is called on quit.
 */
export class Settings {
  private static _decoded: DecodedSettings = decodeSettings(null);
  private static _timer: NodeJS.Timeout | null = null;
  private static readonly SAVE_DELAY = 500;

  private constructor() { }

  /**
   * The live settings object. Mutate it, then call `save()`.
   */
  public static get data(): AppSettings {
    return this._decoded.settings;
  }

  /**
   * Load settings from disk. A missing or corrupt file gives defaults.
   */
  public static load(): void {
    try {
      this._decoded = decodeSettings(JSON.parse(fs.readFileSync(Paths.settingsFile, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Could not read ${Paths.settingsFile}, using defaults:`, error);
      }
      this._decoded = decodeSettings(null);
    }
  }

  /**
   * Schedule a save shortly.
   */
  public static save(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch((error) => console.error("Could not save settings:", error));
    }, this.SAVE_DELAY);
  }

  /**
   * Write settings now, via a temporary file and rename so a crash mid-write
   * never leaves a truncated file.
   */
  public static async flush(): Promise<void> {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const json = JSON.stringify(encodeSettings(this._decoded), null, 2);
    await fsp.mkdir(Path.dirname(Paths.settingsFile), { recursive: true });
    const tmp = `${Paths.settingsFile}.tmp`;
    await fsp.writeFile(tmp, json);
    await fsp.rename(tmp, Paths.settingsFile);
  }

  /**
   * Synchronous variant of `flush()` for the last moments of shutdown.
   */
  public static flushSync(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    fs.mkdirSync(Path.dirname(Paths.settingsFile), { recursive: true });
    const tmp = `${Paths.settingsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(encodeSettings(this._decoded), null, 2));
    fs.renameSync(tmp, Paths.settingsFile);
  }
}

export default Settings;
