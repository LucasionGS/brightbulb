/**
 * Screen mirroring sessions, from the main process's side.
 *
 * Streaming is a two-part handshake with the bridge:
 *
 * 1. **Claim** the entertainment area over CLIP (`action: start`). Only then
 *    does the bridge accept a DTLS handshake from this application.
 * 2. **Stream** over DTLS (done by the sync process).
 *
 * Releasing (`action: stop`) matters just as much: an area left active locks
 * every other Hue app, the official one included, out of it. So:
 *
 * - every start and stop runs through one queue, so they never interleave;
 * - a new claim waits for any release still in flight, or a quick off/on
 *   could land the release after the new claim and drop the area mid-stream;
 * - every way a session can end (stop, error, crash, quit) releases the area,
 *   from the main process, so it happens even if the sync process died.
 */
import EventEmitter from "node:events";
import type Clip from "@shared/hueTypes";
import type { SyncOptions, SyncPhase, SyncStats, SyncVM } from "@shared/ipc";
import { ratesToSmoothing, smoothingToRates, type ProcessingSettings } from "@shared/color/process";
import type { CaptureBackendId } from "@shared/settingsCodec";
import type BridgeConnection from "../hue/BridgeConnection";
import type ClipClient from "../hue/ClipClient";
import { preferredArea, selectAreas } from "../hue/selectors";
import Secrets from "../Secrets";
import Settings from "../Settings";
import type SyncHost from "./SyncHost";

const STOP_TIMEOUT = 3000;
// Right after claiming, the event stream may still report the area as free.
const TAKEOVER_GRACE = 3000;

export class SyncController extends EventEmitter {
  private _phase: SyncPhase = "idle";
  private _status = "Not running";
  private _error: string | null = null;
  private _stats: SyncStats | null = null;
  private _activeBackend: CaptureBackendId | null = null;

  private _queue: Promise<unknown> = Promise.resolve();
  private _pendingRelease: Promise<void> = Promise.resolve();
  private _claim: { client: ClipClient; areaId: string; streamer: string | null; since: number } | null = null;
  private _appId: string | null = null;

  constructor(private readonly connection: BridgeConnection, private readonly host: SyncHost) {
    super();
    host.on("phase", (phase) => {
      if (this._phase !== "starting") return;
      if (phase === "connecting") this._setStatus("Connecting to the bridge…");
      else if (phase === "capturing") this._setStatus("Starting screen capture…");
      else if (phase === "streaming") this._setPhase("streaming", "Mirroring");
    });
    host.on("stats", (stats) => {
      this._stats = stats;
      this.emit("changed");
    });
    host.on("stopped", (message) => void this._enqueue(() => this._endSession(message)));
    host.on("exit", () => {
      if (this._claim) void this._enqueue(() => this._endSession("The streaming process stopped unexpectedly."));
    });
    connection.on("changed", () => this._checkTakeover());
    connection.on("state", (state) => {
      if (state !== "connected" && this._claim) {
        void this._enqueue(() => this._endSession("Lost the connection to the bridge."));
      }
    });
  }

  public get phase(): SyncPhase {
    return this._phase;
  }

  /**
   * True while a session is starting or running.
   */
  public get active(): boolean {
    return this._phase === "starting" || this._phase === "streaming";
  }

  public get vm(): SyncVM {
    const s = Settings.data.sync;
    return {
      phase: this._phase,
      status: this._status,
      error: this._error,
      areaId: this.selectedAreaId(),
      activeBackend: this._activeBackend,
      stats: this._phase === "streaming" ? this._stats : null,
      options: {
        brightness: s.brightness,
        saturation: s.saturation,
        smoothing: ratesToSmoothing(s.attack),
        screenAtPositiveY: s.screenAtPositiveY,
        fps: s.targetFps,
        backend: s.captureBackend,
        monitor: s.monitor,
      },
    };
  }

  /**
   * The saved area if it still exists, else the preferred one.
   */
  public selectedAreaId(): string | null {
    const areas = selectAreas(this.connection.store);
    const saved = areas.find((a) => a.id === Settings.data.sync.entertainmentId);
    return (saved ?? preferredArea(areas))?.id ?? null;
  }

  /**
   * Start mirroring.
   * @throws With a readable message when it cannot start.
   */
  public start(): Promise<void> {
    return this._enqueue(() => this._start());
  }

  public stop(): Promise<void> {
    return this._enqueue(() => this._stop());
  }

  /**
   * Stop (if running) and wait for the area to be released. Used on quit.
   */
  public async shutdown(): Promise<void> {
    await this.stop();
    await this._pendingRelease;
  }

  public toggle(): Promise<void> {
    return this.active ? this.stop() : this.start();
  }

  public setArea(id: string): Promise<void> {
    Settings.data.sync.entertainmentId = id;
    Settings.save();
    this.emit("changed");
    return this._restartIfActive();
  }

  /**
   * Apply option changes. Colour and layout changes apply live; capture
   * changes (backend, monitor, rate) restart a running session.
   */
  public setOptions(options: Partial<SyncOptions>): Promise<void> {
    const s = Settings.data.sync;
    if (options.brightness !== undefined) s.brightness = options.brightness;
    if (options.saturation !== undefined) s.saturation = options.saturation;
    if (options.smoothing !== undefined) Object.assign(s, smoothingToRates(options.smoothing));
    if (options.screenAtPositiveY !== undefined) s.screenAtPositiveY = options.screenAtPositiveY;
    const restart = (options.fps !== undefined && options.fps !== s.targetFps)
      || (options.backend !== undefined && options.backend !== s.captureBackend)
      || (options.monitor !== undefined && options.monitor !== s.monitor);
    if (options.fps !== undefined) s.targetFps = options.fps;
    if (options.backend !== undefined) s.captureBackend = options.backend;
    if (options.monitor !== undefined) s.monitor = options.monitor;
    Settings.save();

    if (this._claim) {
      this.host.post({
        type: "update",
        processing: options.brightness !== undefined || options.saturation !== undefined || options.smoothing !== undefined ? processing() : undefined,
        screenAtPositiveY: options.screenAtPositiveY,
      });
    }
    this.emit("changed");
    return restart ? this._restartIfActive() : Promise.resolve();
  }

  private _restartIfActive(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return this._enqueue(async () => {
      await this._stop();
      await this._start();
    });
  }

  private _enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this._queue.then(task, task);
    this._queue = run.catch(() => undefined);
    return run;
  }

  private async _start(): Promise<void> {
    if (this._claim) return;
    const client = this.connection.client;
    const target = this.connection.target;
    if (!client || !target) {
      return this._refuse("Not connected to the bridge.");
    }
    const areaId = this.selectedAreaId();
    const area = selectAreas(this.connection.store).find((a) => a.id === areaId);
    if (!area) {
      return this._refuse("No entertainment area. Create one in the Hue app first.");
    }
    const credentials = await Secrets.get(target.bridgeId);
    if (!credentials) {
      return this._refuse("Missing bridge credentials. Pair with the bridge again.");
    }
    const s = Settings.data.sync;
    let backend: CaptureBackendId;
    try {
      // Resolved before claiming, so a failure here never leaves the area held.
      backend = s.captureBackend === "auto" ? await this._detectedBackend() : s.captureBackend;
    } catch (error) {
      return this._refuse((error as Error).message);
    }

    this._error = null;
    this._stats = null;
    this._setPhase("starting", "Claiming the entertainment area…");
    await this._pendingRelease;

    try {
      this._appId ??= await client.getApplicationId();
      await client.put("entertainment_configuration", area.id, { action: "start" });
      // Read live: the cached copy cannot be trusted for who holds the area.
      const live = await client.get<Clip.EntertainmentConfiguration>("entertainment_configuration", area.id);
      if (live?.status !== "active") {
        throw new Error("The bridge did not hand over the entertainment area.");
      }
      const streamer = live.active_streamer?.rid ?? null;
      if (this._appId && streamer && streamer !== this._appId) {
        // Not ours, so it must not be released either.
        this._setPhase("idle", "Not running", "Another app is already streaming to this area.");
        return;
      }
      this._claim = { client, areaId: area.id, streamer, since: Date.now() };
    } catch (error) {
      this._release(client, area.id);
      return this._fail(`Could not start the area: ${(error as Error).message}`);
    }

    const reply = await this.host.request({
      type: "start",
      options: {
        host: target.host,
        identity: credentials.appKey,
        pskHex: credentials.clientKey,
        areaId: area.id,
        channels: area.channels,
        gridWidth: s.gridWidth,
        gridHeight: s.gridHeight,
        fps: s.targetFps,
        processing: processing(),
        screenAtPositiveY: s.screenAtPositiveY,
        backend,
        monitor: s.monitor,
      },
    }, 30000);
    if (!reply.ok) {
      return this._endSession(reply.message);
    }
    this._activeBackend = (reply.value as { backend: CaptureBackendId }).backend;
    if (this._phase === "starting") this._setStatus("Starting screen capture…");
    this.emit("changed");
  }

  private async _detectedBackend(): Promise<CaptureBackendId> {
    const reply = await this.host.request({ type: "detect" });
    const detected = reply.ok ? (reply.value as { detected: CaptureBackendId | null }).detected : null;
    if (!detected) throw new Error("No screen capture method is available. See Settings for what to install.");
    return detected;
  }

  private async _stop(): Promise<void> {
    if (!this._claim && this._phase === "idle") return;
    this._setPhase("stopping", "Stopping…");
    const stopped = await this.host.request({ type: "stop" }, STOP_TIMEOUT);
    if (!stopped.ok) this.host.kill();
    this._releaseClaim();
    this._setPhase("idle", "Not running");
  }

  /**
   * End a session that stopped on its own, keeping the reason on screen.
   */
  private async _endSession(message: string): Promise<void> {
    if (this.host.running) {
      const stopped = await this.host.request({ type: "stop" }, STOP_TIMEOUT);
      if (!stopped.ok) this.host.kill();
    }
    this._releaseClaim();
    this._fail(message);
  }

  private _releaseClaim(): void {
    const claim = this._claim;
    this._claim = null;
    this._stats = null;
    if (claim) this._release(claim.client, claim.areaId);
  }

  private _release(client: ClipClient, areaId: string): void {
    const previous = this._pendingRelease;
    this._pendingRelease = previous.then(() => client.put("entertainment_configuration", areaId, { action: "stop" }))
      .catch((error) => console.warn("Could not release the entertainment area:", (error as Error).message));
  }

  /**
   * Stop when the event stream shows the area was freed or taken by someone else.
   */
  private _checkTakeover(): void {
    const claim = this._claim;
    if (!claim || this._phase !== "streaming" || Date.now() - claim.since < TAKEOVER_GRACE) return;
    const config = this.connection.store.get<Clip.EntertainmentConfiguration>(claim.areaId);
    if (!config) return;
    const holder = config.active_streamer?.rid ?? null;
    if (config.status !== "active") {
      void this._enqueue(() => this._endSession("The bridge stopped the entertainment area."));
    }
    else if (holder && claim.streamer && holder !== claim.streamer) {
      // Not ours any more, so do not release it from under the new owner.
      this._claim = null;
      void this._enqueue(() => this._endSession("Another app took over the entertainment area."));
    }
  }

  private _refuse(message: string): void {
    this._setPhase("idle", "Not running", message);
  }

  private _fail(message: string): void {
    this._setPhase("idle", "Not running", message);
  }

  private _setPhase(phase: SyncPhase, status: string, error: string | null = this._error): void {
    this._phase = phase;
    this._status = status;
    this._error = phase === "idle" ? error : null;
    this.emit("changed");
  }

  private _setStatus(status: string): void {
    this._status = status;
    this.emit("changed");
  }
}

function processing(): ProcessingSettings {
  const s = Settings.data.sync;
  return { brightness: s.brightness, saturation: s.saturation, attack: s.attack, decay: s.decay, blackPoint: 0.004 };
}

export interface SyncController {
  // Anything in the view model changed
  emit(event: "changed"): boolean;
  on(event: "changed", listener: () => void): this;
  once(event: "changed", listener: () => void): this;
  off(event: "changed", listener: () => void): this;
}

export default SyncController;
