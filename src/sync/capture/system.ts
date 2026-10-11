/**
 * Facts about the running system that decide which capture backends work.
 */
import fs from "node:fs";
import Path from "node:path";
import { execFile } from "node:child_process";

export type Distro = "arch" | "debian" | "other";

export interface SystemInfo {
  sessionType: "wayland" | "x11" | "other";
  /**
   * Compositor protocol family: wlroots compositors offer screencopy.
   */
  compositor: "hyprland" | "sway" | "wlroots" | "gnome" | "kde" | "other";
  distro: Distro;
  binaries: Record<string, string | null>; // name → absolute path, null if missing
}

const BINARIES = ["wf-recorder", "gpu-screen-recorder", "ffmpeg", "grim", "hyprctl", "swaymsg", "xrandr", "getcap"];

/**
 * Find an executable on PATH.
 */
export function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(Path.delimiter)) {
    if (!dir) continue;
    const candidate = Path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here
    }
  }
  return null;
}

export function detectDistro(): Distro {
  if (fs.existsSync("/etc/arch-release")) return "arch";
  if (fs.existsSync("/etc/debian_version")) return "debian";
  return "other";
}

export function detectSystem(): SystemInfo {
  const env = process.env;
  const sessionType = env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY
    ? "wayland"
    : env.XDG_SESSION_TYPE === "x11" || env.DISPLAY ? "x11" : "other";

  const desktop = (env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
  let compositor: SystemInfo["compositor"] = "other";
  if (env.HYPRLAND_INSTANCE_SIGNATURE || desktop.includes("hyprland")) compositor = "hyprland";
  else if (env.SWAYSOCK || desktop.includes("sway")) compositor = "sway";
  else if (desktop.includes("gnome") || desktop.includes("unity")) compositor = "gnome";
  else if (desktop.includes("kde") || desktop.includes("plasma")) compositor = "kde";
  else if (/river|wayfire|labwc|niri|hikari|dwl|cosmic|mango/.test(desktop)) compositor = "wlroots";

  return {
    sessionType,
    compositor,
    distro: detectDistro(),
    binaries: Object.fromEntries(BINARIES.map((b) => [b, which(b)])),
  };
}

/**
 * Package names per distribution for the tools BrightBulb can use.
 */
const PACKAGES: Record<string, { arch: string; debian: string | null }> = {
  "wf-recorder": { arch: "wf-recorder", debian: "wf-recorder" },
  "gpu-screen-recorder": { arch: "gpu-screen-recorder", debian: null },
  ffmpeg: { arch: "ffmpeg", debian: "ffmpeg" },
  grim: { arch: "grim", debian: "grim" },
};

/**
 * The command that installs `tools` on this distribution, if known.
 */
export function installHint(distro: Distro, tools: string[]): string | null {
  if (tools.length === 0) return null;
  if (distro === "arch") {
    return `sudo pacman -S ${tools.map((t) => PACKAGES[t]?.arch ?? t).join(" ")}`;
  }
  if (distro === "debian") {
    const packages = tools.map((t) => PACKAGES[t]?.debian);
    if (packages.every((p) => p)) return `sudo apt install ${packages.join(" ")}`;
  }
  return null;
}

/**
 * Whether the file at `path` carries the given file capability (e.g. `cap_sys_admin`).
 */
export function hasCapability(getcap: string | null, path: string | null, capability: string): Promise<boolean> {
  if (!getcap || !path) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(getcap, [fs.realpathSync(path)], { timeout: 2000 }, (error, stdout) => {
      resolve(!error && stdout.includes(capability));
    });
  });
}

/**
 * Run a command and return its stdout, or null if it fails.
 */
export function run(command: string, args: string[], timeout = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}
