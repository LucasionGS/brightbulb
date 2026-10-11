/**
 * Rate-limited writes to lights and groups.
 *
 * Dragging a slider produces dozens of changes a second, while the bridge
 * handles roughly ten light commands a second before it starts answering 429.
 * Changes are therefore merged per target (the newest value of each field
 * wins) and flushed at most every 100 ms.
 */
import type { GroupCommand, LightCommand } from "@shared/ipc";
import type ClipClient from "./ClipClient";
import { HttpError } from "./http";

const FLUSH_INTERVAL = 100;
const RATE_LIMIT_PAUSE = 1000;

type Pending = { type: "light" | "grouped_light"; body: Record<string, unknown> };

export class LightWriter {
  private readonly _pending = new Map<string, Pending>();
  private _timer: NodeJS.Timeout | null = null;
  private _flushing = false;
  private _pausedUntil = 0;

  /**
   * @param getClient Returns the live client, or null while disconnected.
   */
  constructor(private readonly getClient: () => ClipClient | null) { }

  /**
   * Queue a change to one light. Brightness, colour and white changes also turn it on.
   */
  public setLight(cmd: LightCommand): void {
    const body: Record<string, unknown> = {};
    if (cmd.brightness !== undefined) body.dimming = { brightness: Math.min(100, Math.max(1, cmd.brightness)) };
    if (cmd.xy) body.color = { xy: { x: cmd.xy[0], y: cmd.xy[1] } };
    if (cmd.mirek !== undefined) body.color_temperature = { mirek: Math.round(cmd.mirek) };
    const implied = Object.keys(body).length > 0;
    if (cmd.on !== undefined || implied) body.on = { on: cmd.on ?? true };
    this._queue(cmd.id, "light", body);
  }

  /**
   * Queue a change to a room through its grouped_light, so lamps change together
   * instead of cascading one by one.
   */
  public setGroup(cmd: GroupCommand): void {
    const body: Record<string, unknown> = {};
    if (cmd.brightness !== undefined) body.dimming = { brightness: Math.min(100, Math.max(1, cmd.brightness)) };
    if (cmd.on !== undefined || cmd.brightness !== undefined) body.on = { on: cmd.on ?? true };
    this._queue(cmd.groupedLightId, "grouped_light", body);
  }

  /**
   * Drop everything not yet sent.
   */
  public clear(): void {
    this._pending.clear();
  }

  public stop(): void {
    this.clear();
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  private _queue(id: string, type: Pending["type"], body: Record<string, unknown>): void {
    if (Object.keys(body).length === 0) return;
    const existing = this._pending.get(id);
    this._pending.set(id, { type, body: { ...existing?.body, ...body } });
    this._schedule();
  }

  private _schedule(): void {
    if (this._timer || this._flushing) return;
    const delay = Math.max(FLUSH_INTERVAL, this._pausedUntil - Date.now());
    this._timer = setTimeout(() => {
      this._timer = null;
      void this._flush();
    }, delay);
  }

  private async _flush(): Promise<void> {
    const client = this.getClient();
    if (!client) {
      // Replaying stale changes after a reconnect would surprise the user.
      this._pending.clear();
      return;
    }
    const batch = [...this._pending.entries()];
    this._pending.clear();
    this._flushing = true;
    try {
      await Promise.all(batch.map(async ([id, item]) => {
        try {
          await client.put(item.type, id, item.body);
        } catch (error) {
          if (error instanceof HttpError && error.status === 429) {
            this._pausedUntil = Date.now() + RATE_LIMIT_PAUSE;
            // Requeue unless a newer change for the same target arrived meanwhile.
            if (!this._pending.has(id)) this._pending.set(id, item);
            return;
          }
          console.debug(`Write to ${item.type} ${id} failed:`, (error as Error).message);
        }
      }));
    } finally {
      this._flushing = false;
      if (this._pending.size > 0) this._schedule();
    }
  }
}

export default LightWriter;
