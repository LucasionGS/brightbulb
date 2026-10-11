/**
 * The contract between the main process and the renderer.
 *
 * Main owns all state and pushes a single coalesced `AppSnapshot` whenever
 * something changes; the renderer sends commands back. Invoke calls return a
 * `Result` instead of throwing, because error subclasses and custom fields do
 * not survive Electron's IPC serialisation.
 */
import type { CaptureBackendId } from "./settingsCodec";

//#region Result
export type Result<T = void> = Success<T> | Failure;

export interface Success<T> {
  ok: true;
  value: T;
}

export interface Failure {
  ok: false;
  /**
   * Machine-readable reason, for the UI to pick wording or an action.
   */
  code: string;
  /**
   * Readable sentence for the user.
   */
  message: string;
}

export function success<T>(value: T): Success<T> {
  return { ok: true, value };
}

export function failure(code: string, message: string): Failure {
  return { ok: false, code, message };
}

export function isSuccess<T>(result: Result<T>): result is Success<T> {
  return result.ok;
}
//#endregion

//#region View models
export type RGB = [number, number, number];

export type ConnectionState = "disconnected" | "connecting" | "connected" | "unauthorized" | "error";

export interface ConnectionVM {
  state: ConnectionState;
  /**
   * Readable detail for the current state, if any.
   */
  detail: string | null;
  /**
   * Machine-readable reason for `error`, e.g. `cert-changed`.
   */
  code: string | null;
  bridge: { id: string; host: string; name: string } | null;
}

export interface LightVM {
  id: string;
  name: string;
  archetype: string;
  on: boolean;
  /**
   * 1-100, or null when the lamp cannot dim (plugs).
   */
  brightness: number | null;
  /**
   * Current colour point and the lamp's gamut triangle, if it has colour.
   */
  color: { xy: [number, number]; gamut: { red: [number, number]; green: [number, number]; blue: [number, number] } } | null;
  /**
   * Current white temperature and its supported range, if it has tunable white.
   */
  temperature: { mirek: number | null; min: number; max: number } | null;
  reachable: boolean;
  /**
   * The colour to tint the light's card with, ignoring brightness.
   */
  displayRgb: RGB;
}

export interface RoomVM {
  id: string;
  name: string;
  kind: "room" | "zone" | "other";
  archetype: string;
  groupedLightId: string | null;
  anyOn: boolean;
  lights: LightVM[];
}

export interface SceneVM {
  id: string;
  name: string;
  palette: RGB[];
  active: boolean;
}

export interface SceneGroupVM {
  name: string;
  scenes: SceneVM[];
}

export interface AreaChannelVM {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface AreaVM {
  id: string;
  name: string;
  type: string;
  active: boolean;
  channels: AreaChannelVM[];
}

export type SyncPhase = "idle" | "starting" | "streaming" | "stopping";

export interface SyncStats {
  fps: number;
  captureFps: number;
  p99IntervalMs: number;
  lights: number;
}

export interface SyncOptions {
  brightness: number;
  saturation: number;
  /**
   * 0 = instant, 0.95 = calm. Stored as attack/decay.
   */
  smoothing: number;
  screenAtPositiveY: boolean;
  fps: number;
  backend: CaptureBackendId | "auto";
  monitor: string | null;
}

export interface SyncVM {
  phase: SyncPhase;
  /**
   * Human-readable status line.
   */
  status: string;
  error: string | null;
  areaId: string | null;
  /**
   * Backend actually used for the running (or last) session.
   */
  activeBackend: CaptureBackendId | null;
  stats: SyncStats | null;
  options: SyncOptions;
}

export interface CaptureBackendVM {
  id: CaptureBackendId;
  name: string;
  available: boolean;
  /**
   * Why the backend cannot be used, when it is not available.
   */
  reason: string | null;
  /**
   * Command that installs what is missing, for this distribution.
   */
  installHint: string | null;
}

export interface CaptureVM {
  backends: CaptureBackendVM[];
  /**
   * What "auto" resolves to on this system.
   */
  detected: CaptureBackendId | null;
}

export interface Monitor {
  /**
   * Output name as the capture backend knows it (`DP-3`, `HDMI-A-1`).
   */
  id: string;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  focused: boolean;
}

export interface BridgeCandidate {
  host: string;
  bridgeId: string;
  name: string;
  supportsV2: boolean;
  source: "mdns" | "cloud" | "manual";
}

export type PairingStage = "idle" | "searching" | "choose" | "linking" | "failed";

export interface PairingVM {
  stage: PairingStage;
  candidates: BridgeCandidate[];
  /**
   * The bridge being linked, during `linking` and `failed`.
   */
  selected: BridgeCandidate | null;
  error: string | null;
  /**
   * Seconds left to press the link button.
   */
  secondsLeft: number;
  totalSeconds: number;
}

export interface SettingsVM {
  closeToTray: boolean;
}

export interface AppSnapshot {
  rev: number;
  version: string;
  connection: ConnectionVM;
  pairing: PairingVM;
  rooms: RoomVM[];
  sceneGroups: SceneGroupVM[];
  areas: AreaVM[];
  sync: SyncVM;
  capture: CaptureVM;
  settings: SettingsVM;
  tray: { available: boolean };
  secrets: { backend: string; insecure: boolean; locked: boolean };
}
//#endregion

//#region Preview
/**
 * One live preview frame, posted on the preview MessagePort at about 15 Hz.
 */
export interface PreviewFrame {
  width: number;
  height: number;
  /**
   * RGBA pixels of the captured grid, ready for `ImageData`.
   */
  pixels: Uint8ClampedArray;
  /**
   * Per-channel output colours as sRGB 0-255, in area channel order.
   */
  channels: { id: number; rgb: RGB }[];
}
//#endregion

//#region Channels
export interface LightCommand {
  id: string;
  on?: boolean;
  brightness?: number;
  xy?: [number, number];
  mirek?: number;
}

export interface GroupCommand {
  groupedLightId: string;
  on?: boolean;
  brightness?: number;
}

/**
 * Invoke channels: `[argument, result]`.
 */
export interface InvokeChannels {
  "app:getSnapshot": [void, AppSnapshot];
  "discovery:start": [void, Result];
  "discovery:probe": [string, Result<BridgeCandidate>];
  "pairing:start": [BridgeCandidate, Result];
  "pairing:cancel": [void, Result];
  "bridge:forget": [void, Result];
  "bridge:retrustCert": [void, Result];
  "bridge:reconnect": [void, Result];
  "scene:recall": [string, Result];
  "sync:start": [void, Result];
  "sync:stop": [void, Result];
  "sync:setArea": [string, Result];
  "sync:setOptions": [Partial<SyncOptions>, Result];
  "capture:listMonitors": [void, Result<Monitor[]>];
  "capture:thumbnails": [string[], Result<{ id: string; dataUrl: string }[]>];
  "preview:enable": [boolean, Result];
  "settings:set": [Partial<SettingsVM>, Result];
  "window:hideToTray": [void, Result];
  "window:minimize": [void, Result];
  "window:toggleMaximize": [void, Result];
  "window:close": [void, Result];
  "app:quit": [void, Result];
}

/**
 * Fire-and-forget channels, renderer to main.
 */
export interface SendChannels {
  "light:set": LightCommand;
  "group:set": GroupCommand;
}

/**
 * Events, main to renderer.
 */
export interface EventChannels {
  "app:snapshot": AppSnapshot;
  "app:navigate": "lights" | "scenes" | "sync" | "settings";
}

/**
 * The API the preload script exposes on `window.bb`.
 */
export interface BrightBulbApi {
  invoke<K extends keyof InvokeChannels>(channel: K, ...arg: InvokeChannels[K][0] extends void ? [] : [InvokeChannels[K][0]]): Promise<InvokeChannels[K][1]>;
  send<K extends keyof SendChannels>(channel: K, payload: SendChannels[K]): void;
  on<K extends keyof EventChannels>(channel: K, listener: (payload: EventChannels[K]) => void): () => void;
  /**
   * Receive live preview frames while the preview is enabled (`preview:enable`).
   */
  onPreview(listener: (frame: PreviewFrame) => void): () => void;
}
//#endregion
