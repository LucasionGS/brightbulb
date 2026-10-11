import { dtls } from "node-dtls-client";

const HUE_STREAM_PORT = 2100;
const HANDSHAKE_TIMEOUT = 10000;
const ATTEMPTS = 2;
const RETRY_DELAY = 300;

/**
 * A DTLS-PSK connection to a bridge's entertainment endpoint.
 *
 * The bridge only offers `TLS_PSK_WITH_AES_128_GCM_SHA256`; the PSK identity is
 * the application key and the key is the hex client key from pairing. The
 * entertainment area must already be started over CLIP, or the bridge never
 * answers the handshake.
 */
export class DtlsTransport {
  private _closed = false;
  private _onClose: ((error: Error | null) => void) | null = null;

  private constructor(private readonly socket: dtls.Socket) {
    socket.on("error", (error: Error) => this._end(error));
    socket.on("close", () => this._end(null));
  }

  /**
   * Connect, retrying once: a lost handshake packet is not retransmitted by
   * the library, so a second attempt is cheaper than a long timeout.
   * @throws With a readable message when both attempts fail.
   */
  public static async connect(host: string, identity: string, pskHex: string): Promise<DtlsTransport> {
    const psk = Buffer.from(pskHex, "hex");
    if (psk.length !== 16) {
      throw new Error("The stored client key is not a 32-character hex key. Pair with the bridge again.");
    }
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY));
      try {
        return new DtlsTransport(await handshake(host, identity, psk));
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw new Error(`DTLS handshake with ${host} failed: ${lastError?.message ?? "unknown error"}. Check that no other app is streaming to this bridge.`);
  }

  public get closed(): boolean {
    return this._closed;
  }

  /**
   * Called once when the connection ends on its own (the bridge closed it or
   * the socket failed). Not called after `close()`.
   */
  public onClose(listener: (error: Error | null) => void): void {
    this._onClose = listener;
  }

  /**
   * Send one datagram.
   * @param callback Receives the send error, if any.
   */
  public send(payload: Buffer, callback: (error: Error | null) => void): void {
    if (this._closed) {
      callback(new Error("connection closed"));
      return;
    }
    try {
      this.socket.send(payload, (error) => callback(error ?? null));
    } catch (error) {
      // node-dtls-client throws synchronously once the socket has died.
      callback(error as Error);
    }
  }

  public close(): void {
    if (this._closed) return;
    this._closed = true;
    this._onClose = null;
    try {
      this.socket.close();
    } catch {
      // Already closed
    }
  }

  private _end(error: Error | null): void {
    if (this._closed) return;
    this._closed = true;
    const listener = this._onClose;
    this._onClose = null;
    listener?.(error);
  }
}

function handshake(host: string, identity: string, psk: Buffer): Promise<dtls.Socket> {
  return new Promise((resolve, reject) => {
    const socket = dtls.createSocket({
      type: host.includes(":") ? "udp6" : "udp4",
      address: host,
      port: HUE_STREAM_PORT,
      psk: { [identity]: psk },
      ciphers: ["TLS_PSK_WITH_AES_128_GCM_SHA256"],
      timeout: HANDSHAKE_TIMEOUT,
    });
    const onError = (error: Error) => {
      socket.off("connected", onConnected);
      reject(error);
    };
    const onConnected = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connected", onConnected);
  });
}

export default DtlsTransport;
