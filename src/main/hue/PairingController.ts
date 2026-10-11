import EventEmitter from "node:events";
import type { BridgeCandidate, PairingVM } from "@shared/ipc";
import type { BridgeCredentials } from "../Secrets";
import { discover, probeBridge } from "./discovery";
import { pairUntilPressed } from "./pairing";

const LINK_TIMEOUT = 120000;

/**
 * Drives the onboarding flow: searching → choosing a bridge → pressing the
 * link button. One pairing attempt runs at a time; starting another or
 * cancelling aborts the current one, and its late result is ignored.
 */
export class PairingController extends EventEmitter {
  private _vm: PairingVM = { stage: "idle", candidates: [], selected: null, error: null, secondsLeft: 0, totalSeconds: LINK_TIMEOUT / 1000 };
  private _abort: AbortController | null = null;
  private _searchId = 0;

  public get vm(): PairingVM {
    return this._vm;
  }

  /**
   * Look for bridges on the network. mDNS first, the cloud only if that finds nothing.
   */
  public async search(): Promise<void> {
    this._abort?.abort();
    this._abort = null;
    const id = ++this._searchId;
    this._update({ stage: "searching", candidates: [], selected: null, error: null });
    const candidates = await discover(true).catch((error) => {
      console.warn("Discovery failed:", error);
      return [];
    });
    if (id !== this._searchId) return;
    this._update({ stage: "choose", candidates });
  }

  /**
   * Confirm a manually entered address and add it to the candidates.
   * @throws With a readable message when nothing answers there.
   */
  public async probe(host: string): Promise<BridgeCandidate> {
    const trimmed = host.trim();
    if (!trimmed) throw new Error("Enter the bridge's IP address.");
    let candidate: BridgeCandidate;
    try {
      candidate = await probeBridge(trimmed, "manual");
    } catch {
      throw new Error(`No Hue bridge answered at ${trimmed}. Check the address and that the bridge is on this network.`);
    }
    const others = this._vm.candidates.filter((c) => c.bridgeId !== candidate.bridgeId);
    this._update({ stage: "choose", candidates: [candidate, ...others] });
    return candidate;
  }

  /**
   * Wait for the link button on `candidate`, then emit `paired`.
   */
  public async pair(candidate: BridgeCandidate): Promise<void> {
    if (!candidate.supportsV2) {
      throw new Error("This bridge does not support the v2 API. BrightBulb needs a square (v2) Hue bridge.");
    }
    this._abort?.abort();
    const abort = new AbortController();
    this._abort = abort;
    this._update({ stage: "linking", selected: candidate, error: null, secondsLeft: this._vm.totalSeconds });

    try {
      const { credentials, fingerprint } = await pairUntilPressed({
        host: candidate.host,
        timeoutMs: LINK_TIMEOUT,
        onTick: (secondsLeft) => {
          if (!abort.signal.aborted) this._update({ secondsLeft });
        },
      }, abort.signal);
      if (abort.signal.aborted) return;
      this._abort = null;
      this.emit("paired", candidate, credentials, fingerprint);
      this._update({ stage: "idle", selected: null, candidates: [] });
    } catch (error) {
      if (abort.signal.aborted) return;
      this._abort = null;
      this._update({ stage: "failed", error: (error as Error).message });
    }
  }

  /**
   * Abort a running pairing attempt and go back to the list; outside the link
   * step, leave onboarding altogether.
   */
  public cancel(): void {
    if (this._abort) {
      this._abort.abort();
      this._abort = null;
      this._update({ stage: this._vm.candidates.length ? "choose" : "idle", selected: null });
    }
    else if (this._vm.stage !== "idle") {
      this.reset();
    }
  }

  /**
   * Leave onboarding entirely.
   */
  public reset(): void {
    this._abort?.abort();
    this._abort = null;
    this._searchId++;
    this._update({ stage: "idle", candidates: [], selected: null, error: null });
  }

  private _update(patch: Partial<PairingVM>): void {
    this._vm = { ...this._vm, ...patch };
    this.emit("changed");
  }
}

export interface PairingController {
  // Pairing succeeded
  emit(event: "paired", candidate: BridgeCandidate, credentials: BridgeCredentials, fingerprint: string | null): boolean;
  on(event: "paired", listener: (candidate: BridgeCandidate, credentials: BridgeCredentials, fingerprint: string | null) => void): this;

  // View model changed
  emit(event: "changed"): boolean;
  on(event: "changed", listener: () => void): this;
}

export default PairingController;
