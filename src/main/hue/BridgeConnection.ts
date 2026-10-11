/**
 * Bridge connection lifecycle: a state machine with automatic reconnection.
 *
 * A session is: open the event stream → read every resource → replay any
 * events that arrived during the read → connected. When the stream drops, the
 * next session starts at once (keeping the old data on screen); only when that
 * fails does the state turn to `error` and back off, 1 s doubling to 30 s,
 * capped low so a bridge rebooting after a firmware update is picked up fast.
 */
import EventEmitter from "node:events";
import { normalizeBridgeId } from "@shared/bridgeId";
import type Clip from "@shared/hueTypes";
import type { ConnectionState } from "@shared/ipc";
import ClipClient from "./ClipClient";
import { HttpError } from "./http";
import PinnedAgent, { CertificateMismatchError } from "./PinnedAgent";
import ResourceStore from "./ResourceStore";
import EventStream from "./sse";

const BACKOFF_START = 1000;
const BACKOFF_MAX = 30000;
// A stream can sit half-open after a network change without either end noticing.
const HEALTH_INTERVAL = 60000;

/**
 * The address now answers as a different bridge (DHCP handed it out again).
 */
export class BridgeMismatchError extends Error {
  public readonly code = "bridge-mismatch";

  constructor(host: string) {
    super(`A different Hue bridge now answers at ${host}. Pair with your bridge again.`);
    this.name = "BridgeMismatchError";
  }
}

export interface BridgeTarget {
  bridgeId: string;
  host: string;
  appKey: string;
  /**
   * Pinned certificate fingerprint, or null to accept and report the first one seen.
   */
  pin: string | null;
}

export class BridgeConnection extends EventEmitter {
  public readonly store = new ResourceStore();
  private _state: ConnectionState = "disconnected";
  private _detail: string | null = null;
  private _code: string | null = null;
  private _target: BridgeTarget | null = null;
  private _client: ClipClient | null = null;
  private _stream: EventStream | null = null;
  private _generation = 0;
  private _wake: (() => void) | null = null;
  private _pin: string | null = null;

  public get state(): ConnectionState {
    return this._state;
  }

  public get detail(): string | null {
    return this._detail;
  }

  public get code(): string | null {
    return this._code;
  }

  public get target(): BridgeTarget | null {
    return this._target;
  }

  /**
   * The REST client while connected, otherwise null.
   */
  public get client(): ClipClient | null {
    return this._state === "connected" ? this._client : null;
  }

  /**
   * Start (or restart) the connection loop. Returns immediately.
   */
  public connect(target: BridgeTarget): void {
    this.disconnect();
    this._target = target;
    const generation = ++this._generation;
    void this._run(generation);
  }

  /**
   * Stop the loop and drop all resources.
   */
  public disconnect(detail: string | null = null): void {
    this._generation++;
    this._stream?.close();
    this._stream = null;
    this._client = null;
    this._wake?.();
    this.store.clear();
    this.emit("changed");
    this._setState("disconnected", detail);
  }

  /**
   * Skip the remaining backoff and retry now.
   */
  public retryNow(): void {
    this._wake?.();
  }

  private _setState(state: ConnectionState, detail: string | null = null, code: string | null = null): void {
    if (state === this._state && detail === this._detail && code === this._code) return;
    this._state = state;
    this._detail = detail;
    this._code = code;
    console.info(`Bridge state: ${state}${detail ? ` (${detail})` : ""}`);
    this.emit("state", state);
  }

  private async _run(generation: number): Promise<void> {
    const target = this._target!;
    this._pin = target.pin;
    const agent = new PinnedAgent(() => this._pin, { keepAlive: true, maxSockets: 6 });
    // The event stream gets its own agent, so it never ties up a pooled socket.
    const streamAgent = new PinnedAgent(() => this._pin, { keepAlive: false });
    const client = new ClipClient(target.host, target.appKey, agent);
    this._client = client;

    let backoff = BACKOFF_START;
    let quietRetry = false;
    while (generation === this._generation) {
      if (!quietRetry) this._setState("connecting");
      try {
        await this._session(generation, client, streamAgent, target);
        // The session was established and has now ended: reconnect at once,
        // keeping the current state and data on screen.
        backoff = BACKOFF_START;
        quietRetry = true;
        continue;
      } catch (error) {
        if (generation !== this._generation) return;
        quietRetry = false;
        if (error instanceof CertificateMismatchError || error instanceof BridgeMismatchError) {
          this._setState("error", error.message, error.code);
          return;
        }
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          this._setState("unauthorized", "BrightBulb's access to this bridge was revoked. Pair with it again to continue.");
          return;
        }
        this._setState("error", `Cannot reach the bridge: ${(error as Error).message}. Retrying in ${Math.round(backoff / 1000)} s.`);
        await this._sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
      }
    }
  }

  private async _session(generation: number, client: ClipClient, streamAgent: PinnedAgent, target: BridgeTarget): Promise<void> {
    const stream = new EventStream(client.host, target.appKey, streamAgent);
    this._stream = stream;
    let ready = false;
    const buffered: Clip.Event[][] = [];
    stream.on("events", (batch) => {
      if (!ready) {
        buffered.push(batch);
        return;
      }
      if (this.store.apply(batch)) this.emit("changed");
    });

    const closed = new Promise<Error | null>((resolve) => stream.once("close", resolve));
    stream.open();
    const opened = await Promise.race([
      new Promise<true>((resolve) => stream.once("open", () => resolve(true))),
      closed,
    ]);
    if (opened !== true) throw opened ?? new Error("the event stream closed immediately");

    let resources: Clip.Resource[];
    try {
      resources = await client.getAll();
    } catch (error) {
      stream.close();
      throw error;
    }
    // The pin (or first-use certificate) only proves it is *a* bridge; make
    // sure it is the one we paired with.
    const bridge = resources.find((r) => r.type === "bridge") as Clip.Bridge | undefined;
    if (bridge?.bridge_id && normalizeBridgeId(bridge.bridge_id) !== target.bridgeId) {
      stream.close();
      throw new BridgeMismatchError(target.host);
    }
    if (!this._pin) {
      this._pin = streamAgent.seen.get(target.host) ?? null;
      if (this._pin) this.emit("pinned", this._pin);
    }
    this.store.reset(resources);
    if (generation !== this._generation) {
      stream.close();
      return;
    }
    for (const batch of buffered) this.store.apply(batch);
    ready = true;
    this.emit("changed");
    this._setState("connected");

    const health = setInterval(() => {
      client.ping().catch((error) => {
        console.warn("Bridge health check failed, reconnecting:", error);
        stream.abort(error);
      });
    }, HEALTH_INTERVAL);
    const error = await closed;
    clearInterval(health);
    if (error && generation === this._generation) {
      console.warn("Event stream ended:", error.message);
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this._wake = () => {
        this._wake = null;
        done();
      };
    });
  }
}

export interface BridgeConnection {
  // Connection state changed
  emit(event: "state", state: ConnectionState): boolean;
  on(event: "state", listener: (state: ConnectionState) => void): this;
  once(event: "state", listener: (state: ConnectionState) => void): this;
  off(event: "state", listener: (state: ConnectionState) => void): this;

  // First certificate seen for an unpinned bridge, to be saved
  emit(event: "pinned", fingerprint: string): boolean;
  on(event: "pinned", listener: (fingerprint: string) => void): this;
  once(event: "pinned", listener: (fingerprint: string) => void): this;
  off(event: "pinned", listener: (fingerprint: string) => void): this;

  // Resources changed
  emit(event: "changed"): boolean;
  on(event: "changed", listener: () => void): this;
  once(event: "changed", listener: () => void): this;
  off(event: "changed", listener: () => void): this;
}

export default BridgeConnection;
