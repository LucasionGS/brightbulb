import { spawn, type ChildProcess } from "node:child_process";
import type { CaptureBackendVM, Monitor } from "@shared/ipc";
import type { CaptureBackendId } from "@shared/settingsCodec";
import type { Thumbnail } from "@shared/syncMessages";
import { FrameReader, frameToBgra, type PixelLayout } from "./FrameReader";
import type { SystemInfo } from "./system";

export interface CaptureRequest {
  /**
   * Output to capture, or null for the backend's default (the focused one).
   */
  monitor: string | null;
  width: number;
  height: number;
  fps: number;
}

export type FrameHandler = (frame: Buffer, layout: PixelLayout) => void;

/**
 * A running capture. `onExit` fires once if it ends without `stop()`.
 */
export interface CaptureSession {
  stop(): Promise<void>;
}

/**
 * One way of getting downscaled frames of a monitor.
 *
 * Subclasses override `check()`, `listMonitors()` and `start()`. The default
 * `thumbnail()` runs a short capture and keeps its first frame.
 */
export abstract class CaptureBackend {
  public abstract readonly id: CaptureBackendId;
  public abstract readonly name: string;

  constructor(public readonly system: SystemInfo) { }

  /**
   * Whether this backend can run here, and if not, why and how to fix it.
   */
  public abstract check(): Promise<CaptureBackendVM>;

  public abstract listMonitors(): Promise<Monitor[]>;

  public abstract start(request: CaptureRequest, onFrame: FrameHandler, onExit: (error: Error | null) => void): CaptureSession;

  /**
   * Capture a single small frame of `monitor`.
   */
  public thumbnail(monitor: string, width: number, height: number, timeoutMs = 4000): Promise<Thumbnail> {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (result: Thumbnail | Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        void session.stop();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`No frame from ${monitor} within ${timeoutMs / 1000} s.`)), timeoutMs);
      const session = this.start(
        { monitor, width, height, fps: 10 },
        (frame, layout) => finish({ id: monitor, width, height, bgra: frameToBgra(frame, layout, width, height) }),
        (error) => finish(error ?? new Error("Capture ended before the first frame.")),
      );
    });
  }

  /**
   * Resolve a null monitor to the focused (or first) one, for tools that
   * insist on a name.
   */
  protected async resolveMonitor(monitor: string | null): Promise<string | null> {
    if (monitor) return monitor;
    const monitors = await this.listMonitors().catch(() => []);
    return (monitors.find((m) => m.focused) ?? monitors[0])?.id ?? null;
  }

  protected vm(available: boolean, reason: string | null = null, installHint: string | null = null): CaptureBackendVM {
    return { id: this.id, name: this.name, available, reason, installHint };
  }
}

/**
 * Runs a chain of processes (`a | b | c`) whose last stdout is raw video, and
 * feeds it to a `FrameReader`.
 */
export class ProcessPipeline implements CaptureSession {
  private readonly _children: ChildProcess[] = [];
  private readonly _reader: FrameReader;
  private _stderrTail: string[] = [];
  private _stopping = false;
  private _exited = false;

  /**
   * @param commands Each `[command, args]`, connected stdout → stdin in order.
   * @param width Frame width the last command outputs.
   * @param height Frame height the last command outputs.
   * @param onFrame Frame callback.
   * @param onExit Called once if the pipeline dies without `stop()`.
   */
  constructor(
    commands: [string, string[]][],
    width: number,
    height: number,
    onFrame: FrameHandler,
    private readonly onExit: (error: Error | null) => void,
  ) {
    this._reader = new FrameReader(width, height, onFrame);
    commands.forEach(([command, args], i) => {
      const last = i === commands.length - 1;
      const child = spawn(command, args, {
        stdio: [i === 0 ? "ignore" : "pipe", "pipe", "pipe"],
        // Its own process group, so a stray child of the tool dies with it.
        detached: true,
      });
      const previous = this._children[i - 1];
      if (previous?.stdout && child.stdin) {
        previous.stdout.pipe(child.stdin);
        child.stdin.on("error", () => { /* Downstream exited; reported via exit */ });
      }
      if (last) {
        child.stdout?.on("data", (chunk: Buffer) => this._reader.pushStdout(chunk));
      }
      child.stderr?.on("data", (chunk: Buffer) => {
        if (last) this._reader.pushStderr(chunk);
        this._stderrTail.push(...chunk.toString().split("\n").filter((l) => l.trim()));
        this._stderrTail = this._stderrTail.slice(-12);
      });
      child.on("error", (error) => this._fail(new Error(`Could not run ${command}: ${error.message}`)));
      child.on("exit", (code, signal) => {
        if (this._stopping) return;
        const tail = this._stderrTail.slice(-3).join(" / ");
        this._fail(new Error(`${command} exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ""}`));
      });
      this._children.push(child);
    });
  }

  public stop(): Promise<void> {
    this._stopping = true;
    this._reader.dispose();
    return Promise.all(this._children.map((child) => killGroup(child))).then(() => undefined);
  }

  private _fail(error: Error): void {
    if (this._exited || this._stopping) return;
    this._exited = true;
    void this.stop();
    this.onExit(error);
  }
}

/**
 * SIGTERM the child's process group, escalating to SIGKILL after a second.
 */
function killGroup(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
      resolve();
      return;
    }
    const pid = child.pid;
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone
      }
      resolve();
    }, 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export default CaptureBackend;
