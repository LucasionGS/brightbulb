import type { CaptureVM } from "@shared/ipc";
import type { CaptureBackendId } from "@shared/settingsCodec";
import type CaptureBackend from "./CaptureBackend";
import { GsrBackend, KmsGrabBackend, WfRecorderBackend, X11GrabBackend } from "./backends";
import PortalBackend from "./PortalBackend";
import { detectSystem, type SystemInfo } from "./system";

/**
 * All capture backends, in the order "auto" tries them.
 */
export class CaptureRegistry {
  public readonly system: SystemInfo;
  public readonly backends: CaptureBackend[];
  public readonly portal: PortalBackend;
  private _detected: CaptureVM | null = null;

  constructor(requestPortal: (width: number, height: number, fps: number) => void, releasePortal: () => void) {
    this.system = detectSystem();
    this.portal = new PortalBackend(this.system, requestPortal, releasePortal);
    this.backends = [
      new WfRecorderBackend(this.system),
      new GsrBackend(this.system),
      new X11GrabBackend(this.system),
      new KmsGrabBackend(this.system),
      this.portal,
    ];
  }

  public get(id: CaptureBackendId): CaptureBackend {
    return this.backends.find((b) => b.id === id)!;
  }

  /**
   * Check every backend and work out what "auto" means here. Cached.
   */
  public async detect(): Promise<CaptureVM> {
    if (this._detected) return this._detected;
    const backends = await Promise.all(this.backends.map((b) => b.check()));
    this._detected = { backends, detected: backends.find((b) => b.available)?.id ?? null };
    return this._detected;
  }

  /**
   * Turn a setting ("auto" or an id) into a usable backend.
   * @throws When the requested backend is unavailable.
   */
  public async resolve(choice: CaptureBackendId | "auto"): Promise<CaptureBackend> {
    const { backends, detected } = await this.detect();
    if (choice === "auto") {
      if (!detected) throw new Error("No screen capture method is available.");
      return this.get(detected);
    }
    const vm = backends.find((b) => b.id === choice);
    if (!vm?.available) {
      throw new Error(`${vm?.name ?? choice} cannot be used: ${vm?.reason ?? "unavailable"}${vm?.installHint ? ` Install it with: ${vm.installHint}` : ""}`);
    }
    return this.get(choice);
  }
}

export default CaptureRegistry;
