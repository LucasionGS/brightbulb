/**
 * Turning raw CLIP resources into the view models the UI renders.
 * Pure functions over a `ResourceStore`, recomputed on every change, so no
 * derived state can go stale (v1's scene "active" badge did).
 */
import type Clip from "@shared/hueTypes";
import type { AreaVM, LightVM, RGB, RoomVM, SceneGroupVM, SceneVM } from "@shared/ipc";
import { gamutFor, mirekToRgb, xyToRgb, type Gamut } from "@shared/color/convert";
import type ResourceStore from "./ResourceStore";

const DEFAULT_MIREK_RANGE = { min: 153, max: 500 };
// Warm white, for lamps that report neither colour nor temperature.
const PLAIN_WHITE: RGB = [1, 0.84, 0.62];
const PALETTE_SIZE = 6;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * Lights grouped by room, plus an "Other lights" group for lights in no room.
 * Rooms without lights are left out.
 */
export function selectRooms(store: ResourceStore): RoomVM[] {
  const lights = new Map(store.all<Clip.Light>("light").map((light) => [light.id, light]));
  const unreachable = unreachableDevices(store);
  const placed = new Set<string>();
  const rooms: RoomVM[] = [];

  for (const room of store.all<Clip.Group>("room")) {
    const members: LightVM[] = [];
    for (const child of room.children ?? []) {
      // Room children are devices; their light services are the lamps.
      const device = store.get<Clip.Device>(child.rid);
      const ids = child.rtype === "light"
        ? [child.rid]
        : (device?.services ?? []).filter((s) => s.rtype === "light").map((s) => s.rid);
      for (const id of ids) {
        const light = lights.get(id);
        if (!light || placed.has(id)) continue;
        placed.add(id);
        members.push(toLightVM(light, unreachable));
      }
    }
    if (members.length === 0) continue;
    members.sort(byName);
    rooms.push({
      id: room.id,
      name: room.metadata?.name ?? "Room",
      kind: "room",
      archetype: room.metadata?.archetype ?? "other",
      groupedLightId: room.services?.find((s) => s.rtype === "grouped_light")?.rid ?? null,
      anyOn: members.some((l) => l.on),
      lights: members,
    });
  }
  rooms.sort(byName);

  const others = [...lights.values()].filter((l) => !placed.has(l.id)).map((l) => toLightVM(l, unreachable)).sort(byName);
  if (others.length > 0) {
    rooms.push({ id: "other", name: "Other lights", kind: "other", archetype: "other", groupedLightId: null, anyOn: others.some((l) => l.on), lights: others });
  }
  return rooms;
}

/**
 * Device ids whose Zigbee radio the bridge cannot reach. Usually the lamp is
 * switched off at the wall, so controls stay enabled.
 */
function unreachableDevices(store: ResourceStore): Set<string> {
  const out = new Set<string>();
  for (const conn of store.all<Clip.ZigbeeConnectivity>("zigbee_connectivity")) {
    if (conn.owner && conn.status && conn.status !== "connected") out.add(conn.owner.rid);
  }
  return out;
}

export function lightGamut(light: Clip.Light): Gamut {
  const g = light.color?.gamut;
  return g ? { red: g.red, green: g.green, blue: g.blue } : gamutFor(light.color?.gamut_type);
}

export function toLightVM(light: Clip.Light, unreachable: Set<string>): LightVM {
  const gamut = lightGamut(light);
  const xy = light.color?.xy;
  const schema = light.color_temperature?.mirek_schema;
  const temperature = light.color_temperature
    ? {
      mirek: light.color_temperature.mirek_valid === false ? null : light.color_temperature.mirek,
      min: schema?.mirek_minimum ?? DEFAULT_MIREK_RANGE.min,
      max: schema?.mirek_maximum ?? DEFAULT_MIREK_RANGE.max,
    }
    : null;

  let displayRgb: RGB = PLAIN_WHITE;
  if (xy) {
    // The bridge keeps xy current even in white mode, so it is the best tint.
    displayRgb = xyToRgb([xy.x, xy.y], 1, gamut);
  }
  else if (temperature?.mirek) {
    displayRgb = mirekToRgb(temperature.mirek);
  }

  return {
    id: light.id,
    name: light.metadata?.name ?? "Light",
    archetype: light.metadata?.archetype ?? "classic_bulb",
    on: light.on?.on ?? false,
    brightness: light.dimming ? Math.max(1, Math.round(light.dimming.brightness)) : null,
    color: light.color
      ? {
        xy: [xy?.x ?? gamut.red.x, xy?.y ?? gamut.red.y],
        gamut: { red: [gamut.red.x, gamut.red.y], green: [gamut.green.x, gamut.green.y], blue: [gamut.blue.x, gamut.blue.y] },
      }
      : null,
    temperature,
    reachable: !(light.owner && unreachable.has(light.owner.rid)),
    displayRgb,
  };
}

/**
 * Scenes grouped by the room or zone they belong to, both sorted by name.
 */
export function selectSceneGroups(store: ResourceStore): SceneGroupVM[] {
  const groups = new Map<string, SceneGroupVM>();
  for (const scene of store.all<Clip.Scene>("scene")) {
    const groupName = store.get<Clip.Group>(scene.group?.rid)?.metadata?.name ?? "Other";
    // Keyed by group id, so two rooms with the same name stay separate.
    const key = scene.group?.rid ?? "other";
    if (!groups.has(key)) groups.set(key, { name: groupName, scenes: [] });
    groups.get(key)!.scenes.push(toSceneVM(scene, store));
  }
  const out = [...groups.values()];
  out.forEach((g) => g.scenes.sort(byName));
  return out.sort(byName);
}

export function toSceneVM(scene: Clip.Scene, store: ResourceStore): SceneVM {
  const palette: RGB[] = [];
  for (const { target, action } of scene.actions ?? []) {
    if (palette.length >= PALETTE_SIZE) break;
    if (action.on && !action.on.on) continue;
    // Fold brightness in, with a floor so dim scenes still show their hue.
    const level = Math.max(0.35, (action.dimming?.brightness ?? 100) / 100);
    if (action.color?.xy) {
      const light = store.get<Clip.Light>(target.rid);
      palette.push(xyToRgb([action.color.xy.x, action.color.xy.y], level, light ? lightGamut(light) : undefined));
    }
    else if (action.color_temperature?.mirek) {
      palette.push(mirekToRgb(action.color_temperature.mirek).map((c) => c * level) as RGB);
    }
    else {
      palette.push(PLAIN_WHITE.map((c) => c * level) as RGB);
    }
  }
  const status = scene.status?.active;
  return {
    id: scene.id,
    name: scene.metadata?.name ?? "Scene",
    palette,
    active: !!status && status !== "inactive",
  };
}

/**
 * Entertainment areas sorted by name, channels sorted by id.
 */
export function selectAreas(store: ResourceStore): AreaVM[] {
  return store.all<Clip.EntertainmentConfiguration>("entertainment_configuration").map((config) => ({
    id: config.id,
    name: config.metadata?.name ?? config.name ?? "Entertainment area",
    type: config.configuration_type ?? "other",
    active: config.status === "active",
    channels: (config.channels ?? [])
      .map((c) => ({ id: c.channel_id, x: c.position?.x ?? 0, y: c.position?.y ?? 0, z: c.position?.z ?? 0 }))
      .sort((a, b) => a.id - b.id),
  })).sort(byName);
}

/**
 * The area most likely to be wanted for screen mirroring: one the user set up
 * for screens, else the first.
 */
export function preferredArea(areas: AreaVM[]): AreaVM | null {
  return areas.find((a) => a.type.toLowerCase() === "screen") ?? areas[0] ?? null;
}
