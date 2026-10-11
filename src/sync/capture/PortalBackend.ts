import type { MessagePortMain } from "electron";
import type { CaptureBackendVM, Monitor } from "@shared/ipc";
import type { Thumbnail } from "@shared/syncMessages";
import CaptureBackend, { type CaptureRequest, type CaptureSession, type FrameHandler } from "./CaptureBackend";
import { layoutFor } from "./FrameReader";
import type { SystemInfo } from "./system";

const RGBA = layoutFor("rgba")!;

/**
 * Messages from the hidden capture window.
 */
export type PortalMessage =
  | { type: "frame"; width: number; height: number; rgba: Uint8Array }
  | { type: "ended"; message: string };

/**
 * Last resort: Chromium's screen capture through the xdg-desktop-portal, which
 * shows the system's "choose a screen" dialog. Runs in a hidden window owned by
 * the main process, which sends its frames here over a MessagePort.
 */
export class PortalBackend extends CaptureBackend {
  public readonly id = "portal" as const;
  public readonly name = "Screen sharing portal (asks which screen)";
  private _port: MessagePortMain | null = null;
  private _handler: ((message: PortalMessage) => void) | null = null;

  /**
   * @param system System facts.
   * @param request Asks the main process to open the hidden capture window.
   * @param release Asks the main process to close it.
   */
  constructor(system: SystemInfo, private readonly request: (width: number, height: number, fps: number) => void, private readonly release: () => void) {
    super(system);
  }

  /**
   * Receive frames from the capture window on `port`.
   */
  public attachPort(port: MessagePortMain): void {
    this._port?.close();
    this._port = port;
    port.on("message", (event) => this._handler?.(event.data as PortalMessage));
    port.start();
  }

  public async check(): Promise<CaptureBackendVM> {
    return this.vm(true, "Asks you to choose a screen each time mirroring starts.");
  }

  public async listMonitors(): Promise<Monitor[]> {
    return [{ id: "portal", name: "Chosen in the system dialog", width: 0, height: 0, x: 0, y: 0, focused: true }];
  }

  public start(request: CaptureRequest, onFrame: FrameHandler, onExit: (error: Error | null) => void): CaptureSession {
    let ended = false;
    this._handler = (message) => {
      if (ended) return;
      if (message.type === "frame") {
        if (message.width !== request.width || message.height !== request.height) return;
        onFrame(Buffer.from(message.rgba.buffer, message.rgba.byteOffset, message.rgba.byteLength), RGBA);
      }
      else {
        ended = true;
        onExit(new Error(message.message));
      }
    };
    this.request(request.width, request.height, request.fps);
    return {
      stop: async () => {
        ended = true;
        this._handler = null;
        this.release();
      },
    };
  }

  public override thumbnail(): Promise<Thumbnail> {
    return Promise.reject(new Error("The portal picks the screen itself, so there is nothing to preview."));
  }
}

export default PortalBackend;
