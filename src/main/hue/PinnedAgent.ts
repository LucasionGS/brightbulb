import https from "node:https";
import tls from "node:tls";
import type { Duplex } from "node:stream";

/**
 * Raised when a bridge presents a different certificate from the one pinned at pairing.
 */
export class CertificateMismatchError extends Error {
  public readonly code = "cert-changed";

  constructor(public readonly host: string, public readonly fingerprint: string) {
    super(`The bridge at ${host} presented a different certificate than when it was paired. If you replaced or reset the bridge, trust the new certificate in Settings.`);
    this.name = "CertificateMismatchError";
  }
}

/**
 * HTTPS agent that trusts the bridge's certificate on first use, then pins it.
 *
 * Hue bridges serve self-signed (or Signify-CA) certificates keyed to their
 * bridge id, and the Bridge Pro's chain differs from older bridges, so normal
 * chain verification cannot be used. Instead the SHA-256 fingerprint seen at
 * pairing is stored and every later connection must match it.
 *
 * The check runs in `createConnection`, after the TLS handshake but before the
 * agent hands the socket to a request, so no request bytes (and therefore no
 * app key) are ever written to an impostor.
 */
export class PinnedAgent extends https.Agent {
  /**
   * The fingerprint each host presented most recently, pinned or not.
   */
  public readonly seen = new Map<string, string>();

  /**
   * @param getPin Returns the expected fingerprint, or null to accept any certificate (first contact).
   * @param options Regular agent options.
   */
  constructor(private readonly getPin: () => string | null, options?: https.AgentOptions) {
    super(options);
  }

  public override createConnection(
    options: tls.ConnectionOptions,
    callback?: (error: Error | null, socket: Duplex) => void,
  ): Duplex | null | undefined {
    const socket = tls.connect({ ...options, rejectUnauthorized: false });
    const host = String(options.host ?? "");

    const onError = (error: Error) => callback?.(error, socket);
    socket.once("error", onError);
    socket.once("secureConnect", () => {
      socket.off("error", onError);
      const fingerprint = socket.getPeerCertificate()?.fingerprint256 ?? "";
      this.seen.set(host, fingerprint);
      const pin = this.getPin();
      if (pin && fingerprint !== pin) {
        socket.destroy();
        callback?.(new CertificateMismatchError(host, fingerprint), socket);
        return;
      }
      callback?.(null, socket);
    });
    // Returning nothing tells the agent to wait for the callback.
    return undefined;
  }
}

export default PinnedAgent;
