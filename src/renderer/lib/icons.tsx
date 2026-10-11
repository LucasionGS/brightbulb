import { createElement } from "react";
import {
  Bath, BedDouble, Briefcase, Clapperboard, CookingPot, Gamepad2, House, Lamp, LampCeiling, LampDesk, LampFloor,
  LampWallUp, Lightbulb, Plug, Sofa, Spotlight, Tv, type LucideIcon,
} from "lucide-react";

/**
 * Icon for a light's Hue archetype.
 */
export function lightIcon(archetype: string): LucideIcon {
  if (archetype.includes("plug")) return Plug;
  if (archetype.includes("spot") || archetype.includes("recessed")) return Spotlight;
  if (archetype.includes("ceiling") || archetype.includes("pendant") || archetype.includes("chandelier")) return LampCeiling;
  if (archetype.includes("floor") || archetype.includes("bollard")) return LampFloor;
  if (archetype.includes("wall") || archetype.includes("flood")) return LampWallUp;
  if (archetype.includes("desk") || archetype.includes("table") || archetype.includes("hue_go")) return LampDesk;
  if (archetype.includes("lightstrip") || archetype.includes("hue_play") || archetype.includes("tv")) return Tv;
  if (archetype.includes("lamp")) return Lamp;
  return Lightbulb;
}

/**
 * Icon for a room's Hue archetype.
 */
export function roomIcon(archetype: string): LucideIcon {
  if (archetype.includes("living")) return Sofa;
  if (archetype.includes("bedroom") || archetype.includes("nursery")) return BedDouble;
  if (archetype.includes("kitchen") || archetype.includes("dining")) return CookingPot;
  if (archetype.includes("bath") || archetype.includes("toilet")) return Bath;
  if (archetype.includes("office") || archetype.includes("studio")) return Briefcase;
  if (archetype.includes("tv")) return Tv;
  if (archetype.includes("gym") || archetype.includes("recreation") || archetype.includes("game")) return Gamepad2;
  if (archetype.includes("theater") || archetype.includes("music")) return Clapperboard;
  return House;
}

/**
 * Renders the icon for a light archetype.
 */
export function LightIcon(props: { archetype: string; size?: number }) {
  return createElement(lightIcon(props.archetype), { size: props.size ?? 22 });
}

/**
 * Renders the icon for a room archetype.
 */
export function RoomIcon(props: { archetype: string; size?: number }) {
  return createElement(roomIcon(props.archetype), { size: props.size ?? 18 });
}
