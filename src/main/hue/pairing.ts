/**
 * Bridge pairing: obtaining an app key and the entertainment client key.
 *
 * The request asks for `generateclientkey`, because the client key (the DTLS
 * pre-shared key streaming needs) is issued **once**, at pairing time, and can
 * never be recovered afterwards.
 */
import os from "node:os";
import type { BridgeCredentials } from "../Secrets";
import { request, urlHost } from "./http";
import { probeAgent } from "./discovery";

// The bridge enforces "appname#devicename" with tight length limits and rejects
// the whole request if either half is too long.
const APP_NAME_MAX = 20;
const DEVICE_NAME_MAX = 19;

/**
 * The bridge answered error 101: its link button has not been pressed.
 */
export class LinkButtonNotPressed extends Error {
  constructor() {
    super("Press the link button on the bridge.");
    this.name = "LinkButtonNotPressed";
  }
}

/**
 * Build the `devicetype` string identifying this install to the bridge.
 */
export function defaultDeviceType(appName = "brightbulb"): string {
  const device = os.hostname() || "linux";
  return `${appName.slice(0, APP_NAME_MAX)}#${device.slice(0, DEVICE_NAME_MAX)}`;
}

/**
 * Turn the bridge's pairing reply into credentials, or throw the error it reports.
 * @throws LinkButtonNotPressed for error 101; Error for anything else.
 */
export function parsePairingResponse(body: unknown): BridgeCredentials {
  const first = Array.isArray(body) ? body[0] : null;
  if (typeof first !== "object" || first === null) {
    throw new Error(`Unexpected pairing response: ${JSON.stringify(body)}`);
  }
  const { error, success } = first as { error?: { type?: number; description?: string }; success?: { username?: unknown; clientkey?: unknown } };
  if (error) {
    if (error.type === 101) throw new LinkButtonNotPressed();
    throw new Error(`The bridge refused pairing: ${error.description ?? `error ${error.type}`}.`);
  }
  if (typeof success?.username !== "string") {
    throw new Error(`Pairing response contained no username: ${JSON.stringify(body)}`);
  }
  if (typeof success.clientkey !== "string" || !success.clientkey) {
    // Pre-1.22 firmware ignores generateclientkey. Lights would work but
    // streaming never would, so fail here rather than at the DTLS handshake.
    throw new Error("The bridge issued no client key. Screen mirroring needs bridge firmware with API version 1.22 or newer; update the bridge in the Hue app.");
  }
  return { appKey: success.username, clientKey: success.clientkey };
}

/**
 * One pairing attempt, https first and http as a fallback for old firmware.
 * @returns The credentials and the certificate fingerprint the bridge presented over https.
 */
export async function createCredentials(host: string, signal?: AbortSignal): Promise<{ credentials: BridgeCredentials; fingerprint: string | null }> {
  const payload = { devicetype: defaultDeviceType(), generateclientkey: true };
  let lastError: unknown = null;
  for (const scheme of ["https", "http"]) {
    let body: unknown;
    try {
      ({ body } = await request(`${scheme}://${urlHost(host)}/api`, { method: "POST", body: payload, agent: probeAgent, timeout: 5000, signal }));
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      continue;
    }
    return { credentials: parsePairingResponse(body), fingerprint: probeAgent.seen.get(host) ?? null };
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not reach the bridge at ${host}.`);
}

export interface PairingLoopOptions {
  host: string;
  /**
   * How long to wait for the link button, in ms. Default is 120000.
   */
  timeoutMs?: number;
  /**
   * Pause between attempts, in ms. Default is 1000.
   */
  intervalMs?: number;
  /**
   * Called about once a second with the seconds left.
   */
  onTick?: (secondsLeft: number) => void;
  /**
   * Injected for tests.
   */
  attempt?: (host: string, signal: AbortSignal) => ReturnType<typeof createCredentials>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Keep trying to pair until the link button is pressed, the time runs out or
 * the signal aborts. Exactly one attempt is in flight at a time, and a success
 * that arrives after the deadline or an abort is discarded.
 * @throws Error on timeout or a non-101 error; the abort reason on abort.
 */
export async function pairUntilPressed(opts: PairingLoopOptions, signal: AbortSignal): ReturnType<typeof createCredentials> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const intervalMs = opts.intervalMs ?? 1000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const attempt = opts.attempt ?? createCredentials;
  const deadline = now() + timeoutMs;

  while (true) {
    signal.throwIfAborted();
    opts.onTick?.(Math.max(0, Math.ceil((deadline - now()) / 1000)));
    try {
      const result = await attempt(opts.host, signal);
      signal.throwIfAborted();
      if (now() > deadline) break;
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof LinkButtonNotPressed)) throw error;
    }
    if (now() + intervalMs > deadline) break;
    await sleep(intervalMs, signal);
  }
  throw new Error("Timed out waiting for the link button.");
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
