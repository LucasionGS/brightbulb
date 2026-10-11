/**
 * The streaming loop: newest captured frame → mapper → processor → HueStream
 * frame → DTLS, at a steady target rate.
 *
 * Capture and sending are decoupled. Capture fills a single "latest frame"
 * slot whenever a frame arrives; the pacer wakes on an absolute schedule and
 * always processes the newest one. On a static screen the same frame is simply
 * processed again, which also keeps the bridge's ~10 s stream timeout fed and
 * keeps smoothing time-consistent.
 *
 * Everything on the hot path is preallocated.
 */
import { ColorProcessor, toU16, type ProcessingSettings } from "@shared/color/process";
import { ScreenMapper, type ChannelPosition } from "@shared/stream/ScreenMapper";
import { HueStreamFrame } from "@shared/stream/protocol";
import type { PreviewFrame, SyncStats } from "@shared/ipc";
import { frameToLinear, frameToRgba, type PixelLayout } from "./capture/FrameReader";
import type DtlsTransport from "./DtlsTransport";

const MAX_SEND_FAILURES = 10;
// Rebase the schedule instead of bursting to catch up after a stall.
const MAX_BEHIND_INTERVALS = 10;
const PREVIEW_INTERVAL = 66;

export interface StreamEngineOptions {
  transport: DtlsTransport;
  areaId: string;
  channels: ChannelPosition[];
  gridWidth: number;
  gridHeight: number;
  fps: number;
  processing: ProcessingSettings;
  screenAtPositiveY: boolean;
  /**
   * Called once when streaming fails and stops by itself.
   */
  onFatal: (message: string) => void;
  onStats: (stats: SyncStats) => void;
}

export class StreamEngine {
  private readonly _opts: StreamEngineOptions;
  private _mapper: ScreenMapper;
  private readonly _processor: ColorProcessor;
  private readonly _frame: HueStreamFrame;
  private readonly _u16: Uint16Array;
  private readonly _linear: Float32Array;
  private _latest: Buffer | null = null;
  private _latestLayout: PixelLayout | null = null;
  private _hasNew = false;

  private _timer: NodeJS.Timeout | null = null;
  private _running = false;
  private _start = 0;
  private _ticks = 0;
  private _sequence = 0;
  private _sendFailures = 0;
  private _lastTick = 0;

  // Stats over the current one-second window
  private _intervals: number[] = [];
  private _sentInWindow = 0;
  private _capturedInWindow = 0;
  private _statsTimer: NodeJS.Timeout | null = null;
  private _lastCaptureAt = 0;

  private _previewSink: ((frame: PreviewFrame) => void) | null = null;
  private _previewAt = 0;
  private _previewRgba: Uint8ClampedArray;

  constructor(opts: StreamEngineOptions) {
    this._opts = opts;
    this._mapper = new ScreenMapper(opts.channels, opts.gridWidth, opts.gridHeight, { screenAtPositiveY: opts.screenAtPositiveY });
    this._processor = new ColorProcessor(opts.channels.length, opts.processing);
    this._frame = new HueStreamFrame(opts.areaId, opts.channels.map((c) => c.channelId));
    this._u16 = new Uint16Array(opts.channels.length * 3);
    this._linear = new Float32Array(opts.gridWidth * opts.gridHeight * 3);
    this._previewRgba = new Uint8ClampedArray(opts.gridWidth * opts.gridHeight * 4);
  }

  /**
   * `performance.now()` of the last captured frame, or 0 before the first.
   */
  public get lastFrameAt(): number {
    return this._lastCaptureAt;
  }

  public start(): void {
    this._running = true;
    this._processor.reset();
    this._start = performance.now();
    this._lastTick = this._start;
    this._ticks = 0;
    this._statsTimer = setInterval(() => this._emitStats(), 1000);
    this._schedule();
  }

  public stop(): void {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    if (this._statsTimer) clearInterval(this._statsTimer);
    this._timer = null;
    this._statsTimer = null;
  }

  /**
   * Hand over a captured frame. Only the newest is kept; the buffer is copied
   * because capture reuses it.
   */
  public submitFrame(frame: Buffer, layout: PixelLayout): void {
    if (!this._latest || this._latest.length !== frame.length) {
      this._latest = Buffer.alloc(frame.length);
    }
    frame.copy(this._latest);
    this._latestLayout = layout;
    this._hasNew = true;
    this._capturedInWindow++;
    this._lastCaptureAt = performance.now();
  }

  public setProcessing(settings: ProcessingSettings): void {
    this._processor.settings = settings;
  }

  public setScreenAtPositiveY(value: boolean): void {
    this._mapper = new ScreenMapper(this._opts.channels, this._opts.gridWidth, this._opts.gridHeight, { screenAtPositiveY: value });
  }

  /**
   * Receive preview frames at about 15 Hz, or stop with null.
   */
  public setPreviewSink(sink: ((frame: PreviewFrame) => void) | null): void {
    this._previewSink = sink;
  }

  private _schedule(): void {
    if (!this._running) return;
    const interval = 1000 / this._opts.fps;
    let due = this._start + (this._ticks + 1) * interval;
    const now = performance.now();
    if (now - due > interval * MAX_BEHIND_INTERVALS) {
      this._start = now;
      this._ticks = 0;
      due = now + interval;
    }
    this._timer = setTimeout(() => this._tick(), Math.max(0, due - now));
  }

  private _tick(): void {
    if (!this._running) return;
    this._ticks++;
    const now = performance.now();
    this._intervals.push(now - this._lastTick);
    this._lastTick = now;

    if (this._latest && this._latestLayout) {
      // Re-linearise only when capture delivered something new.
      if (this._hasNew) {
        frameToLinear(this._latest, this._latestLayout, this._linear);
        this._hasNew = false;
      }
      const srgb = this._processor.process(this._mapper.sample(this._linear));
      toU16(srgb, this._u16);
      const payload = this._frame.write(this._sequence++, this._u16);
      this._opts.transport.send(payload, (error) => this._onSent(error));
      this._sentInWindow++;
      this._maybePreview(srgb, now);
    }
    this._schedule();
  }

  private _onSent(error: Error | null): void {
    if (!error) {
      this._sendFailures = 0;
      return;
    }
    if (++this._sendFailures >= MAX_SEND_FAILURES && this._running) {
      this.stop();
      this._opts.onFatal(`Streaming stopped: ${error.message}`);
    }
  }

  private _maybePreview(srgb: Float32Array, now: number): void {
    if (!this._previewSink || now - this._previewAt < PREVIEW_INTERVAL || !this._latest || !this._latestLayout) return;
    this._previewAt = now;
    frameToRgba(this._latest, this._latestLayout, this._previewRgba);
    this._previewSink({
      width: this._opts.gridWidth,
      height: this._opts.gridHeight,
      pixels: this._previewRgba.slice(),
      channels: this._opts.channels.map((c, i) => ({
        id: c.channelId,
        rgb: [Math.round(srgb[i * 3] * 255), Math.round(srgb[i * 3 + 1] * 255), Math.round(srgb[i * 3 + 2] * 255)],
      })),
    });
  }

  private _emitStats(): void {
    const sorted = this._intervals.sort((a, b) => a - b);
    const p99 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : 0;
    this._opts.onStats({
      fps: this._sentInWindow,
      captureFps: this._capturedInWindow,
      p99IntervalMs: Math.round(p99 * 10) / 10,
      lights: this._opts.channels.length,
    });
    this._intervals = [];
    this._sentInWindow = 0;
    this._capturedInWindow = 0;
  }
}

export default StreamEngine;
