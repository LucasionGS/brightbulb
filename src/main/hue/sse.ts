import EventEmitter from "node:events";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import type Clip from "@shared/hueTypes";
import { HttpError, urlHost } from "./http";

/**
 * One server-sent event.
 */
export interface SseEvent {
  id: string | null;
  event: string;
  data: string;
}

/**
 * Incremental parser for `text/event-stream`.
 * Feed it chunks as they arrive, split anywhere (even mid-line or mid-UTF-8
 * sequence when given bytes); it returns each event once its blank line arrives.
 */
export class SseParser {
  private _buffer = "";
  private _decoder = new TextDecoder();
  private _data: string[] = [];
  private _event = "";
  private _id: string | null = null;

  public push(chunk: Buffer | string): SseEvent[] {
    this._buffer += typeof chunk === "string" ? chunk : this._decoder.decode(chunk, { stream: true });
    const events: SseEvent[] = [];

    let newline: number;
    while ((newline = this._buffer.search(/\r\n|\r|\n/)) !== -1) {
      // A lone \r at the end of the buffer may be the first half of \r\n.
      if (this._buffer[newline] === "\r" && newline === this._buffer.length - 1) break;
      const line = this._buffer.slice(0, newline);
      const width = this._buffer.startsWith("\r\n", newline) ? 2 : 1;
      this._buffer = this._buffer.slice(newline + width);

      if (line === "") {
        if (this._data.length > 0) {
          events.push({ id: this._id, event: this._event || "message", data: this._data.join("\n") });
        }
        this._data = [];
        this._event = "";
        continue;
      }
      if (line.startsWith(":")) continue; // Comment / keepalive

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "data") this._data.push(value);
      else if (field === "event") this._event = value;
      else if (field === "id") this._id = value;
    }
    return events;
  }
}

/**
 * The bridge's CLIP v2 event stream.
 *
 * Emits `events` with each batch of resource changes, `open` once the stream
 * is established and `close` (with the error, if any) when it ends. It does not
 * reconnect by itself; `BridgeConnection` owns that, because every reconnect
 * also needs a full resync to catch up on what was missed.
 */
export class EventStream extends EventEmitter {
  private _request: ReturnType<typeof https.request> | null = null;
  private _closed = false;

  constructor(private readonly host: string, private readonly appKey: string, private readonly agent: https.Agent) {
    super();
  }

  public open(): void {
    const parser = new SseParser();
    const req = https.request(`https://${urlHost(this.host)}/eventstream/clip/v2`, {
      agent: this.agent,
      headers: { "hue-application-key": this.appKey, accept: "text/event-stream" },
    }, (res: IncomingMessage) => {
      if (res.statusCode !== 200) {
        res.resume();
        this._finish(new HttpError(res.statusCode ?? 0, "eventstream", null));
        return;
      }
      res.socket?.setKeepAlive(true, 10000);
      this.emit("open");
      res.on("data", (chunk: Buffer) => {
        for (const event of parser.push(chunk)) {
          try {
            const batch = JSON.parse(event.data) as Clip.Event[];
            if (Array.isArray(batch)) this.emit("events", batch);
          } catch (error) {
            console.warn("Unparseable event from bridge:", error);
          }
        }
      });
      res.on("end", () => this._finish(null));
      res.on("error", (error) => this._finish(error));
    });
    req.on("error", (error) => this._finish(error));
    req.end();
    this._request = req;
  }

  /**
   * End the stream as if it had failed with `error`, emitting `close`.
   */
  public abort(error: Error): void {
    this._finish(error);
  }

  public close(): void {
    this._closed = true;
    this._request?.destroy();
    this._request = null;
  }

  private _finish(error: Error | null): void {
    if (this._closed) return;
    this._closed = true;
    this._request?.destroy();
    this.emit("close", error);
  }
}

export interface EventStream {
  // Stream established
  emit(event: "open"): boolean;
  on(event: "open", listener: () => void): this;
  once(event: "open", listener: () => void): this;
  off(event: "open", listener: () => void): this;

  // Batch of resource changes
  emit(event: "events", batch: Clip.Event[]): boolean;
  on(event: "events", listener: (batch: Clip.Event[]) => void): this;
  once(event: "events", listener: (batch: Clip.Event[]) => void): this;
  off(event: "events", listener: (batch: Clip.Event[]) => void): this;

  // Stream ended
  emit(event: "close", error: Error | null): boolean;
  on(event: "close", listener: (error: Error | null) => void): this;
  once(event: "close", listener: (error: Error | null) => void): this;
  off(event: "close", listener: (error: Error | null) => void): this;
}

export default EventStream;
