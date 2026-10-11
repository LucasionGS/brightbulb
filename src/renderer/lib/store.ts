/**
 * The renderer's view of app state: the latest snapshot from main, with
 * short-lived optimistic overrides layered on top.
 *
 * When the user drags a slider, the change is shown immediately and kept for
 * a moment even if the bridge echoes an older value in between. Without this
 * the slider would jump back mid-drag.
 */
import { useSyncExternalStore } from "react";
import type { AppSnapshot, GroupCommand, LightCommand, LightVM, RGB } from "@shared/ipc";
import { xyToRgb, mirekToRgb } from "@shared/color/convert";

const OVERRIDE_MS = 800;

type LightOverride = { fields: Partial<LightVM>; until: number };

let snapshot: AppSnapshot | null = null;
let merged: AppSnapshot | null = null;
const overrides = new Map<string, LightOverride>();
const listeners = new Set<() => void>();
let expiryTimer: number | null = null;

function emit(): void {
  merged = null;
  for (const listener of listeners) listener();
}

function applyOverrides(base: AppSnapshot): AppSnapshot {
  const now = Date.now();
  for (const [id, o] of overrides) {
    if (o.until <= now) overrides.delete(id);
  }
  if (overrides.size === 0) return base;
  return {
    ...base,
    rooms: base.rooms.map((room) => {
      const lights = room.lights.map((light) => {
        const o = overrides.get(light.id);
        return o ? { ...light, ...o.fields } : light;
      });
      return { ...room, lights, anyOn: lights.some((l) => l.on) };
    }),
  };
}

function scheduleExpiry(): void {
  if (expiryTimer !== null) return;
  expiryTimer = window.setTimeout(() => {
    expiryTimer = null;
    emit();
    if (overrides.size > 0) scheduleExpiry();
  }, OVERRIDE_MS + 20);
}

function override(id: string, fields: Partial<LightVM>): void {
  const existing = overrides.get(id);
  overrides.set(id, { fields: { ...existing?.fields, ...fields }, until: Date.now() + OVERRIDE_MS });
  scheduleExpiry();
  emit();
}

function findLight(id: string): LightVM | undefined {
  for (const room of snapshot?.rooms ?? []) {
    const light = room.lights.find((l) => l.id === id);
    if (light) return light;
  }
  return undefined;
}

/**
 * Start listening for snapshots. Call once at startup.
 */
export async function initStore(): Promise<void> {
  window.bb.on("app:snapshot", (next) => {
    if (snapshot && next.rev <= snapshot.rev) return;
    snapshot = next;
    emit();
  });
  const first = await window.bb.invoke("app:getSnapshot");
  if (!snapshot || first.rev > snapshot.rev) {
    snapshot = first;
    emit();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AppSnapshot | null {
  if (!snapshot) return null;
  merged ??= applyOverrides(snapshot);
  return merged;
}

/**
 * The current app snapshot, or null before the first one arrives.
 */
export function useSnapshot(): AppSnapshot | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Change a light, showing the result immediately.
 */
export function setLight(cmd: LightCommand): void {
  window.bb.send("light:set", cmd);
  const light = findLight(cmd.id);
  const fields: Partial<LightVM> = {};
  const implied = cmd.brightness !== undefined || cmd.xy !== undefined || cmd.mirek !== undefined;
  if (cmd.on !== undefined || implied) fields.on = cmd.on ?? true;
  if (cmd.brightness !== undefined) fields.brightness = cmd.brightness;
  if (cmd.xy && light?.color) {
    fields.color = { ...light.color, xy: cmd.xy };
    fields.displayRgb = xyToRgb(cmd.xy, 1);
  }
  if (cmd.mirek !== undefined && light?.temperature) {
    fields.temperature = { ...light.temperature, mirek: cmd.mirek };
    fields.displayRgb = mirekToRgb(cmd.mirek) as RGB;
  }
  override(cmd.id, fields);
}

/**
 * Switch or dim a whole room. Falls back to per-light writes for rooms the
 * bridge gave no grouped_light.
 */
export function setRoom(roomId: string, cmd: Omit<GroupCommand, "groupedLightId">): void {
  const room = snapshot?.rooms.find((r) => r.id === roomId);
  if (!room) return;
  if (room.groupedLightId) {
    window.bb.send("group:set", { groupedLightId: room.groupedLightId, ...cmd });
    for (const light of room.lights) {
      override(light.id, {
        on: cmd.on ?? true,
        ...(cmd.brightness !== undefined && light.brightness !== null ? { brightness: cmd.brightness } : {}),
      });
    }
  }
  else {
    for (const light of room.lights) {
      setLight({ id: light.id, ...cmd, ...(light.brightness === null ? { brightness: undefined } : {}) });
    }
  }
}
