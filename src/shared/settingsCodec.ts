/**
 * The on-disk settings format, shared with v1.
 *
 * `~/.config/brightbulb/settings.json` keeps v1's snake_case keys so both
 * versions can read it. Unknown keys (including v1's `screencast_restore_token`)
 * are carried through untouched, and v1 ignores the keys v2 adds, so switching
 * back and forth never loses anything.
 */

export type CaptureBackendId = "wf-recorder" | "gsr" | "x11grab" | "kmsgrab" | "portal";
export const CAPTURE_BACKEND_IDS: readonly CaptureBackendId[] = ["wf-recorder", "gsr", "x11grab", "kmsgrab", "portal"];

export interface SyncSettings {
  entertainmentId: string | null;
  gridWidth: number;
  gridHeight: number;
  targetFps: number;
  brightness: number;
  saturation: number;
  attack: number;
  decay: number;
  screenAtPositiveY: boolean;
  captureBackend: CaptureBackendId | "auto";
  monitor: string | null; // null = the capture backend's default output
}

export interface AppSettings {
  bridgeId: string | null;
  bridgeHost: string | null;
  /**
   * SHA-256 fingerprint of the bridge certificate, pinned at pairing.
   */
  bridgeCertSha256: string | null;
  closeToTray: boolean;
  trayHintShown: boolean;
  sync: SyncSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  bridgeId: null,
  bridgeHost: null,
  bridgeCertSha256: null,
  closeToTray: true,
  trayHintShown: false,
  sync: {
    entertainmentId: null,
    gridWidth: 64,
    gridHeight: 36,
    targetFps: 60,
    brightness: 1.0,
    saturation: 1.2,
    attack: 0.6,
    decay: 0.15,
    screenAtPositiveY: false,
    captureBackend: "auto",
    monitor: null,
  },
};

/**
 * Valid ranges, shared by the decoder and the UI sliders.
 */
export const LIMITS = {
  GRID: { MIN: 8, MAX: 256 },
  FPS: { MIN: 1, MAX: 60 },
  BRIGHTNESS: { MIN: 0.1, MAX: 1.5 },
  SATURATION: { MIN: 0.5, MAX: 2.5 },
  ATTACK: { MIN: 0.05, MAX: 1 },
  DECAY: { MIN: 0.01, MAX: 1 },
} as const;

/**
 * Settings plus whatever unknown keys were found, so they can be written back.
 */
export interface DecodedSettings {
  settings: AppSettings;
  extra: Record<string, unknown>;
  syncExtra: Record<string, unknown>;
}

const TOP_KEYS = ["bridge_id", "bridge_host", "bridge_cert_sha256", "close_to_tray", "tray_hint_shown", "sync"];
const SYNC_KEYS = [
  "entertainment_id", "grid_width", "grid_height", "target_fps", "brightness", "saturation",
  "attack", "decay", "screen_at_positive_y", "capture_backend", "monitor",
];

/**
 * Decode a parsed settings file. Anything missing, mistyped or out of range
 * falls back to its default; nothing here throws.
 */
export function decodeSettings(raw: unknown): DecodedSettings {
  const top = isObject(raw) ? raw : {};
  const sync = isObject(top.sync) ? top.sync : {};
  const d = DEFAULT_SETTINGS;

  const backend = sync.capture_backend;
  return {
    settings: {
      bridgeId: str(top.bridge_id, d.bridgeId),
      bridgeHost: str(top.bridge_host, d.bridgeHost),
      bridgeCertSha256: str(top.bridge_cert_sha256, d.bridgeCertSha256),
      closeToTray: bool(top.close_to_tray, d.closeToTray),
      trayHintShown: bool(top.tray_hint_shown, d.trayHintShown),
      sync: {
        entertainmentId: str(sync.entertainment_id, d.sync.entertainmentId),
        gridWidth: Math.round(num(sync.grid_width, d.sync.gridWidth, LIMITS.GRID.MIN, LIMITS.GRID.MAX)),
        gridHeight: Math.round(num(sync.grid_height, d.sync.gridHeight, LIMITS.GRID.MIN, LIMITS.GRID.MAX)),
        targetFps: Math.round(num(sync.target_fps, d.sync.targetFps, LIMITS.FPS.MIN, LIMITS.FPS.MAX)),
        brightness: num(sync.brightness, d.sync.brightness, LIMITS.BRIGHTNESS.MIN, LIMITS.BRIGHTNESS.MAX),
        saturation: num(sync.saturation, d.sync.saturation, LIMITS.SATURATION.MIN, LIMITS.SATURATION.MAX),
        attack: num(sync.attack, d.sync.attack, LIMITS.ATTACK.MIN, LIMITS.ATTACK.MAX),
        decay: num(sync.decay, d.sync.decay, LIMITS.DECAY.MIN, LIMITS.DECAY.MAX),
        screenAtPositiveY: bool(sync.screen_at_positive_y, d.sync.screenAtPositiveY),
        captureBackend: backend === "auto" || CAPTURE_BACKEND_IDS.includes(backend as CaptureBackendId)
          ? backend as CaptureBackendId | "auto"
          : d.sync.captureBackend,
        monitor: str(sync.monitor, d.sync.monitor),
      },
    },
    extra: pickUnknown(top, TOP_KEYS),
    syncExtra: pickUnknown(sync, SYNC_KEYS),
  };
}

/**
 * Encode settings back to the on-disk shape, re-attaching unknown keys.
 */
export function encodeSettings(decoded: DecodedSettings): Record<string, unknown> {
  const { settings: s, extra, syncExtra } = decoded;
  return {
    ...extra,
    version: 2,
    bridge_id: s.bridgeId,
    bridge_host: s.bridgeHost,
    bridge_cert_sha256: s.bridgeCertSha256,
    close_to_tray: s.closeToTray,
    tray_hint_shown: s.trayHintShown,
    sync: {
      ...syncExtra,
      entertainment_id: s.sync.entertainmentId,
      grid_width: s.sync.gridWidth,
      grid_height: s.sync.gridHeight,
      target_fps: s.sync.targetFps,
      brightness: s.sync.brightness,
      saturation: s.sync.saturation,
      attack: s.sync.attack,
      decay: s.sync.decay,
      screen_at_positive_y: s.sync.screenAtPositiveY,
      capture_backend: s.sync.captureBackend,
      monitor: s.sync.monitor,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : value === null ? null : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function pickUnknown(source: Record<string, unknown>, known: string[]): Record<string, unknown> {
  // "version" is always rewritten, so it never needs carrying.
  return Object.fromEntries(Object.entries(source).filter(([key]) => !known.includes(key) && key !== "version"));
}
