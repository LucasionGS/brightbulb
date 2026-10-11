/**
 * Parsers for the various ways of listing monitors. All pure, so they are
 * tested against captured output without the tools installed.
 */
import type { Monitor } from "@shared/ipc";

/**
 * `hyprctl monitors -j`
 */
export function parseHyprctl(json: string): Monitor[] {
  const list = JSON.parse(json) as {
    name: string; description?: string; make?: string; model?: string;
    width: number; height: number; x: number; y: number; focused?: boolean; transform?: number; disabled?: boolean;
  }[];
  return list.filter((m) => !m.disabled).map((m) => {
    // Odd transforms rotate by 90° or 270°, so the visible size swaps.
    const rotated = (m.transform ?? 0) % 2 === 1;
    return {
      id: m.name,
      name: describe(m.name, [m.make, m.model].filter(Boolean).join(" ") || m.description),
      width: rotated ? m.height : m.width,
      height: rotated ? m.width : m.height,
      x: m.x,
      y: m.y,
      focused: !!m.focused,
    };
  });
}

/**
 * `swaymsg -t get_outputs -r`
 */
export function parseSwaymsg(json: string): Monitor[] {
  const list = JSON.parse(json) as {
    name: string; make?: string; model?: string; active?: boolean; focused?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
  }[];
  return list.filter((m) => m.active !== false && m.rect).map((m) => ({
    id: m.name,
    name: describe(m.name, [m.make, m.model].filter(Boolean).join(" ")),
    width: m.rect!.width,
    height: m.rect!.height,
    x: m.rect!.x,
    y: m.rect!.y,
    focused: !!m.focused,
  }));
}

/**
 * `wf-recorder -L`
 */
export function parseWfRecorderList(text: string): Monitor[] {
  // Example:
  // 1. Name: DP-1 Description: BNQ ZOWIE XL LCD F9K00726SL0 (DP-1)
  const out: Monitor[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*\d+\.\s+Name:\s+(\S+)(?:\s+Description:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const description = match[2]?.replace(new RegExp(`\\s*\\(${escapeRegex(match[1])}\\)$`), "");
    out.push({ id: match[1], name: describe(match[1], description), width: 0, height: 0, x: 0, y: 0, focused: out.length === 0 });
  }
  return out;
}

/**
 * `gpu-screen-recorder --list-capture-options`
 */
export function parseGsrCaptureOptions(text: string): Monitor[] {
  // Example:
  // DP-1|1920x1080
  // DP-2|1080x1920
  // region
  // portal
  const out: Monitor[] = [];
  for (const line of text.split("\n")) {
    const match = /^([^|\s]+)\|(\d+)x(\d+)$/.exec(line.trim());
    if (!match) continue;
    out.push({ id: match[1], name: match[1], width: parseInt(match[2]), height: parseInt(match[3]), x: 0, y: 0, focused: out.length === 0 });
  }
  return out;
}

/**
 * `xrandr --listactivemonitors`
 */
export function parseXrandrMonitors(text: string): Monitor[] {
  // Example:
  // Monitors: 2
  //  0: +*DP-1 1920/527x1080/296+0+0  DP-1
  //  1: +HDMI-1 1920/509x1080/286+1920+0  HDMI-1
  const out: Monitor[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*\d+:\s+\+?(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/.exec(line);
    if (!match) continue;
    out.push({
      id: match[2],
      name: match[2],
      width: parseInt(match[3]),
      height: parseInt(match[4]),
      x: parseInt(match[5]),
      y: parseInt(match[6]),
      focused: match[1] === "*",
    });
  }
  return out;
}

/**
 * Fill in sizes and positions from a richer listing (e.g. hyprctl) where the
 * backend's own listing only has names.
 */
export function enrich(monitors: Monitor[], details: Monitor[]): Monitor[] {
  return monitors.map((m) => {
    const d = details.find((x) => x.id === m.id);
    return d ? { ...m, name: d.name, width: m.width || d.width, height: m.height || d.height, x: d.x, y: d.y, focused: d.focused } : m;
  });
}

function describe(id: string, description?: string): string {
  return description ? `${description} (${id})` : id;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
