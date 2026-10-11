import EventEmitter from "node:events";
import Path from "node:path";
import { utilityProcess, type MessagePortMain, type UtilityProcess } from "electron";
import type { SyncStats } from "@shared/ipc";
import type { FromSync, SyncReply, ToSync } from "@shared/syncMessages";

type Request = ToSync extends infer M ? M extends { reqId: number } ? Omit<M, "reqId"> : never : never;

/**
 * Owns the sync utility process: spawns it on demand, matches replies to
 * requests and re-emits its events. If it dies, pending requests fail and
 * `exit` fires; the next request spawns a fresh one.
 */
export class SyncHost extends EventEmitter {
  private _child: UtilityProcess | null = null;
  private _nextId = 1;
  private readonly _pending = new Map<number, { resolve: (r: SyncReply) => void; timer: NodeJS.Timeout }>();

  public get running(): boolean {
    return this._child !== null;
  }

  /**
   * Send a request and wait for its reply.
   * @param timeoutMs Give up after this long. Default is 20000.
   */
  public request(message: Request, timeoutMs = 20000): Promise<SyncReply> {
    const child = this._ensure();
    const reqId = this._nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        resolve({ ok: false, code: "timeout", message: "The streaming process did not answer in time." });
      }, timeoutMs);
      this._pending.set(reqId, { resolve, timer });
      child.postMessage({ ...message, reqId } as ToSync);
    });
  }

  /**
   * Send a message that has no reply, optionally transferring ports.
   */
  public post(message: ToSync, transfer?: MessagePortMain[]): void {
    this._ensure().postMessage(message, transfer);
  }

  /**
   * Hard-stop the process. Its capture tools die with their broken pipes.
   */
  public kill(): void {
    this._child?.kill();
  }

  private _ensure(): UtilityProcess {
    if (this._child) return this._child;
    const child = utilityProcess.fork(Path.join(__dirname, "syncWorker.cjs"), [], {
      serviceName: "BrightBulb Sync",
      stdio: "inherit",
    });
    child.on("message", (message: FromSync) => this._onMessage(message));
    child.on("exit", (code) => {
      if (this._child !== child) return;
      this._child = null;
      for (const [, pending] of this._pending) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, code: "crashed", message: "The streaming process stopped unexpectedly." });
      }
      this._pending.clear();
      this.emit("exit", code);
    });
    this._child = child;
    return child;
  }

  private _onMessage(message: FromSync): void {
    switch (message.type) {
      case "reply": {
        const pending = this._pending.get(message.reqId);
        if (!pending) return;
        this._pending.delete(message.reqId);
        clearTimeout(pending.timer);
        pending.resolve(message.result);
        break;
      }
      case "phase":
        this.emit("phase", message.phase);
        break;
      case "stats":
        this.emit("stats", message.stats);
        break;
      case "stopped":
        this.emit("stopped", message.message);
        break;
      case "portalRequest":
        this.emit("portalRequest", message.width, message.height, message.fps);
        break;
      case "portalRelease":
        this.emit("portalRelease");
        break;
    }
  }
}

export interface SyncHost {
  // Session phase changed
  emit(event: "phase", phase: "connecting" | "capturing" | "streaming"): boolean;
  on(event: "phase", listener: (phase: "connecting" | "capturing" | "streaming") => void): this;

  // Once-a-second stats
  emit(event: "stats", stats: SyncStats): boolean;
  on(event: "stats", listener: (stats: SyncStats) => void): this;

  // The stream ended by itself
  emit(event: "stopped", message: string): boolean;
  on(event: "stopped", listener: (message: string) => void): this;

  // Portal fallback needs the hidden capture window
  emit(event: "portalRequest", width: number, height: number, fps: number): boolean;
  on(event: "portalRequest", listener: (width: number, height: number, fps: number) => void): this;
  emit(event: "portalRelease"): boolean;
  on(event: "portalRelease", listener: () => void): this;

  // The process exited
  emit(event: "exit", code: number): boolean;
  on(event: "exit", listener: (code: number) => void): this;
}

export default SyncHost;
