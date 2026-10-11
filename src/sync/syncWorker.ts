/**
 * Entry point of the sync utility process.
 *
 * Runs capture, colour processing and the DTLS stream on its own event loop
 * and heap, so main-process work (IPC, JSON, GC) cannot delay a 16 ms frame,
 * and so a crash here never takes the window down with it. Main keeps every
 * CLIP call, including releasing the entertainment area, so the area is freed
 * even if this process dies.
 */
import type { MessagePortMain } from "electron";
import type { FromSync, StreamStartOptions, SyncReply, Thumbnail, ToSync } from "@shared/syncMessages";
import type CaptureBackend from "./capture/CaptureBackend";
import type { CaptureSession } from "./capture/CaptureBackend";
import CaptureRegistry from "./capture/registry";
import type { PortalMessage } from "./capture/PortalBackend";
import DtlsTransport from "./DtlsTransport";
import StreamEngine from "./StreamEngine";

const STALL_MS = 3000;

const parent = process.parentPort;

function post(message: FromSync): void {
  parent.postMessage(message);
}

function reply(reqId: number, result: SyncReply): void {
  post({ type: "reply", reqId, result });
}

function errorReply(error: unknown, code = "failed"): SyncReply {
  return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
}

const registry = new CaptureRegistry(
  (width, height, fps) => post({ type: "portalRequest", width, height, fps }),
  () => post({ type: "portalRelease" }),
);

interface Session {
  options: StreamStartOptions;
  backend: CaptureBackend;
  transport: DtlsTransport;
  engine: StreamEngine;
  capture: CaptureSession | null;
  captureStartedAt: number;
  restarted: boolean;
  streaming: boolean;
  watchdog: NodeJS.Timeout;
}

let session: Session | null = null;
let previewPort: MessagePortMain | null = null;

async function startSession(options: StreamStartOptions): Promise<{ backend: string }> {
  await stopSession();
  const backend = await registry.resolve(options.backend);

  post({ type: "phase", phase: "connecting" });
  const transport = await DtlsTransport.connect(options.host, options.identity, options.pskHex);

  const engine = new StreamEngine({
    transport,
    areaId: options.areaId,
    channels: options.channels.map((c) => ({ channelId: c.id, x: c.x, y: c.y, z: c.z })),
    gridWidth: options.gridWidth,
    gridHeight: options.gridHeight,
    fps: options.fps,
    processing: options.processing,
    screenAtPositiveY: options.screenAtPositiveY,
    onFatal: (message) => void fail(message),
    onStats: (stats) => post({ type: "stats", stats }),
  });

  const current: Session = {
    options, backend, transport, engine,
    capture: null,
    captureStartedAt: 0,
    restarted: false,
    streaming: false,
    watchdog: setInterval(() => watch(current), 1000),
  };
  session = current;
  if (previewPort) attachPreview(engine, previewPort);

  transport.onClose((error) => {
    // Usually another app claimed the area, or the bridge rebooted.
    void fail(`The bridge closed the stream${error ? `: ${error.message}` : ""}.`);
  });

  post({ type: "phase", phase: "capturing" });
  startCapture(current);
  engine.start();
  return { backend: backend.id };
}

function startCapture(s: Session): void {
  const { options } = s;
  s.captureStartedAt = performance.now();
  s.capture = s.backend.start(
    { monitor: options.monitor, width: options.gridWidth, height: options.gridHeight, fps: options.fps },
    (frame, layout) => s.engine.submitFrame(frame, layout),
    (error) => {
      if (session !== s) return;
      console.warn("Capture ended:", error?.message);
      restartCapture(s, `Screen capture failed: ${error?.message ?? "it ended unexpectedly"}`);
    },
  );
}

/**
 * Restart capture once; a second failure stops the session.
 */
function restartCapture(s: Session, message: string): void {
  if (s.restarted) {
    void fail(message);
    return;
  }
  s.restarted = true;
  void s.capture?.stop();
  startCapture(s);
}

function watch(s: Session): void {
  if (session !== s) return;
  const lastFrame = s.engine.lastFrameAt;
  if (!s.streaming && lastFrame > 0) {
    s.streaming = true;
    post({ type: "phase", phase: "streaming" });
  }
  // Measured from the later of the last frame and the latest (re)start, so a
  // restart gets its own full grace period.
  if (performance.now() - Math.max(lastFrame, s.captureStartedAt) > STALL_MS) {
    restartCapture(s, `No frames from ${s.backend.name} for ${STALL_MS / 1000} s.`);
  }
}

async function stopSession(): Promise<void> {
  const s = session;
  if (!s) return;
  session = null;
  clearInterval(s.watchdog);
  s.engine.stop();
  s.transport.close();
  await s.capture?.stop();
}

async function fail(message: string): Promise<void> {
  if (!session) return;
  await stopSession();
  post({ type: "stopped", message });
}

function attachPreview(engine: StreamEngine, port: MessagePortMain): void {
  engine.setPreviewSink((frame) => port.postMessage(frame));
}

async function thumbnails(backendId: Parameters<CaptureRegistry["get"]>[0], ids: string[], width: number, height: number): Promise<Thumbnail[]> {
  const backend = await registry.resolve(backendId);
  const out: Thumbnail[] = [];
  // One at a time: several simultaneous screen recorders is asking for trouble.
  for (const id of ids) {
    try {
      out.push(await backend.thumbnail(id, width, height));
    } catch (error) {
      console.warn(`Thumbnail of ${id} failed:`, (error as Error).message);
    }
  }
  return out;
}

parent.on("message", (event) => {
  const message = event.data as ToSync;
  switch (message.type) {
    case "start":
      startSession(message.options).then(
        (value) => reply(message.reqId, { ok: true, value }),
        async (error) => {
          await stopSession();
          reply(message.reqId, errorReply(error));
        },
      );
      break;
    case "stop":
      stopSession().then(() => reply(message.reqId, { ok: true }), (error) => reply(message.reqId, errorReply(error)));
      break;
    case "update":
      if (message.processing) session?.engine.setProcessing(message.processing);
      if (message.screenAtPositiveY !== undefined) session?.engine.setScreenAtPositiveY(message.screenAtPositiveY);
      break;
    case "detect":
      registry.detect().then((value) => reply(message.reqId, { ok: true, value }), (error) => reply(message.reqId, errorReply(error)));
      break;
    case "listMonitors":
      registry.resolve(message.backend)
        .then((backend) => backend.listMonitors())
        .then((value) => reply(message.reqId, { ok: true, value }), (error) => reply(message.reqId, errorReply(error)));
      break;
    case "thumbnails":
      thumbnails(message.backend, message.ids, message.width, message.height)
        .then((value) => reply(message.reqId, { ok: true, value }), (error) => reply(message.reqId, errorReply(error)));
      break;
    case "preview": {
      previewPort?.close();
      previewPort = message.enabled ? event.ports[0] ?? null : null;
      if (session) {
        if (previewPort) attachPreview(session.engine, previewPort);
        else session.engine.setPreviewSink(null);
      }
      break;
    }
    case "portalPort": {
      const port = event.ports[0];
      if (port) registry.portal.attachPort(port);
      break;
    }
  }
});

process.on("uncaughtException", (error) => {
  console.error("Sync process error:", error);
  void fail(`Streaming crashed: ${error.message}`);
});

export type { PortalMessage };
