/**
 * Messages between the main process and the sync utility process.
 *
 * Main owns the bridge (every CLIP call, including entertainment start/stop);
 * the sync process owns capture, colour processing and the DTLS socket.
 */
import type { AreaChannelVM, CaptureVM, Monitor, SyncStats } from "./ipc";
import type { ProcessingSettings } from "./color/process";
import type { CaptureBackendId } from "./settingsCodec";

export interface StreamStartOptions {
  host: string;
  /**
   * DTLS PSK identity: the bridge application key.
   */
  identity: string;
  /**
   * DTLS PSK: the hex client key issued at pairing.
   */
  pskHex: string;
  areaId: string;
  channels: AreaChannelVM[];
  gridWidth: number;
  gridHeight: number;
  fps: number;
  processing: ProcessingSettings;
  screenAtPositiveY: boolean;
  backend: CaptureBackendId;
  monitor: string | null; // null = the backend's default output
}

export type ToSync =
  | { type: "start"; reqId: number; options: StreamStartOptions }
  | { type: "update"; processing?: ProcessingSettings; screenAtPositiveY?: boolean }
  | { type: "stop"; reqId: number }
  | { type: "detect"; reqId: number }
  | { type: "listMonitors"; reqId: number; backend: CaptureBackendId }
  | { type: "thumbnails"; reqId: number; backend: CaptureBackendId; ids: string[]; width: number; height: number }
  | { type: "preview"; enabled: boolean } // Sent with a MessagePort when enabling
  | { type: "portalPort" }; // Sent with the MessagePort of the hidden capture window

export interface Thumbnail {
  id: string;
  width: number;
  height: number;
  /**
   * BGRA pixels, as `nativeImage.createFromBitmap` expects.
   */
  bgra: Uint8Array;
}

export type SyncReply =
  | { ok: true; value?: unknown }
  | { ok: false; code: string; message: string };

export type FromSync =
  | { type: "reply"; reqId: number; result: SyncReply }
  | { type: "phase"; phase: "connecting" | "capturing" | "streaming" }
  | { type: "stats"; stats: SyncStats }
  /**
   * The stream ended without being asked to (error, takeover, capture died).
   */
  | { type: "stopped"; message: string }
  /**
   * The portal backend needs the hidden capture window.
   */
  | { type: "portalRequest"; width: number; height: number; fps: number }
  | { type: "portalRelease" };

export type DetectResult = CaptureVM;
export type MonitorList = Monitor[];
