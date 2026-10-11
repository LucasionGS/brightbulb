/**
 * The capture backends, in auto-detection order. None of them needs the
 * ScreenCast portal (and its screen picker), except the last-resort fallback.
 */
import fs from "node:fs";
import { execFile } from "node:child_process";
import type { CaptureBackendVM, Monitor } from "@shared/ipc";
import type { Thumbnail } from "@shared/syncMessages";
import CaptureBackend, { ProcessPipeline, type CaptureRequest, type CaptureSession, type FrameHandler } from "./CaptureBackend";
import { enrich, parseGsrCaptureOptions, parseHyprctl, parseSwaymsg, parseWfRecorderList, parseXrandrMonitors } from "./monitors";
import { hasCapability, installHint, run } from "./system";

/**
 * Scale to the grid with area averaging, and force a packed 4-byte format.
 */
function scaleFilter(width: number, height: number): string {
  return `scale=${width}:${height}:flags=area,format=bgr0`;
}

/**
 * The compositor's own monitor listing, with positions and focus.
 */
async function compositorMonitors(backend: CaptureBackend): Promise<Monitor[]> {
  const { binaries, compositor } = backend.system;
  if (compositor === "hyprland" && binaries.hyprctl) {
    const json = await run(binaries.hyprctl, ["monitors", "-j"]);
    if (json) return parseHyprctl(json);
  }
  if (compositor === "sway" && binaries.swaymsg) {
    const json = await run(binaries.swaymsg, ["-t", "get_outputs", "-r"]);
    if (json) return parseSwaymsg(json);
  }
  return [];
}

//#region wlroots screencopy (wf-recorder)
/**
 * wlroots compositors (Hyprland, Sway, river…) hand out frames through the
 * wlr-screencopy protocol to any client, no prompt involved. wf-recorder
 * speaks it and pipes frames through ffmpeg's filters, so scaling to the grid
 * happens before the data ever reaches us.
 */
export class WfRecorderBackend extends CaptureBackend {
  public readonly id = "wf-recorder" as const;
  public readonly name = "wlroots screencopy (wf-recorder)";

  public async check(): Promise<CaptureBackendVM> {
    const { sessionType, compositor, binaries, distro } = this.system;
    if (sessionType !== "wayland" || !["hyprland", "sway", "wlroots"].includes(compositor)) {
      return this.vm(false, "Needs a wlroots-based Wayland compositor such as Hyprland or Sway.");
    }
    if (!binaries["wf-recorder"]) {
      return this.vm(false, "wf-recorder is not installed.", installHint(distro, ["wf-recorder"]));
    }
    return this.vm(true);
  }

  public async listMonitors(): Promise<Monitor[]> {
    const rich = await compositorMonitors(this);
    const text = this.system.binaries["wf-recorder"] ? await run(this.system.binaries["wf-recorder"], ["-L"]) : null;
    const listed = text ? parseWfRecorderList(text) : [];
    return listed.length ? enrich(listed, rich) : rich;
  }

  public start(request: CaptureRequest, onFrame: FrameHandler, onExit: (error: Error | null) => void): CaptureSession {
    return deferred(async () => {
      // Without -o on a multi-monitor setup, wf-recorder asks on stdin which output to use.
      const monitor = await this.resolveMonitor(request.monitor);
      return new ProcessPipeline([[this.system.binaries["wf-recorder"]!, [
        "-y",
        ...(monitor ? ["-o", monitor] : []),
        "-r", String(request.fps),
        "-x", "bgr0",
        "-F", scaleFilter(request.width, request.height),
        "-c", "rawvideo",
        "-m", "rawvideo",
        // Not /dev/stdout: Node hands children a socket, which ffmpeg cannot open() by path.
        "-f", "pipe:1",
      ]]], request.width, request.height, onFrame, onExit);
    }, onExit);
  }

  /**
   * grim takes a scaled screenshot through the same protocol in one shot,
   * which is much faster than starting a recording for one frame.
   */
  public override async thumbnail(monitor: string, width: number, height: number): Promise<Thumbnail> {
    const grim = this.system.binaries.grim;
    if (!grim) return super.thumbnail(monitor, width, height);
    const target = (await this.listMonitors()).find((m) => m.id === monitor);
    const scale = target?.width ? Math.min(1, width / target.width) : 0.2;
    const ppm = await new Promise<Buffer>((resolve, reject) => {
      execFile(grim, ["-o", monitor, "-s", scale.toFixed(4), "-t", "ppm", "-"], { encoding: "buffer", timeout: 4000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    return { id: monitor, ...ppmToBgra(ppm) };
  }
}
//#endregion

//#region KMS (gpu-screen-recorder → ffmpeg)
/**
 * gpu-screen-recorder reads the framebuffer straight from KMS through its
 * small `gsr-kms-server` helper, which carries cap_sys_admin, so it works on
 * any Wayland desktop and any GPU (including NVIDIA) without a prompt. It
 * encodes on the GPU, so ffmpeg decodes the stream again and scales it down.
 */
export class GsrBackend extends CaptureBackend {
  public readonly id = "gsr" as const;
  public readonly name = "KMS (gpu-screen-recorder)";

  public async check(): Promise<CaptureBackendVM> {
    const { binaries, distro } = this.system;
    const missing = ["gpu-screen-recorder", "ffmpeg"].filter((b) => !binaries[b]);
    if (missing.length) {
      return this.vm(false, `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not installed.`, installHint(distro, missing));
    }
    return this.vm(true);
  }

  public async listMonitors(): Promise<Monitor[]> {
    const text = await run(this.system.binaries["gpu-screen-recorder"]!, ["--list-capture-options"], 5000);
    const listed = text ? parseGsrCaptureOptions(text) : [];
    return enrich(listed, await compositorMonitors(this));
  }

  public start(request: CaptureRequest, onFrame: FrameHandler, onExit: (error: Error | null) => void): CaptureSession {
    return deferred(async () => {
      const monitor = await this.resolveMonitor(request.monitor) ?? "screen";
      // Downscale on the GPU first, so ffmpeg only decodes a small picture.
      const encodeWidth = Math.max(64, request.width * 4);
      const encodeHeight = Math.max(36, request.height * 4);
      return new ProcessPipeline([
        [this.system.binaries["gpu-screen-recorder"]!, [
          "-w", monitor,
          "-f", String(request.fps),
          "-s", `${encodeWidth}x${encodeHeight}`,
          "-c", "mpegts",
          "-k", "h264",
          "-fm", "cfr",
          "-cursor", "no",
          "-keyint", "0.5",
          "-o", "pipe:1",
        ]],
        [this.system.binaries.ffmpeg!, [
          "-hide_banner", "-loglevel", "info", "-nostats",
          "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0",
          "-f", "mpegts", "-i", "pipe:0",
          "-vf", scaleFilter(request.width, request.height),
          "-f", "rawvideo", "pipe:1",
        ]],
      ], request.width, request.height, onFrame, onExit);
    }, onExit);
  }
}
//#endregion

//#region X11 (ffmpeg x11grab)
export class X11GrabBackend extends CaptureBackend {
  public readonly id = "x11grab" as const;
  public readonly name = "X11 (ffmpeg x11grab)";

  public async check(): Promise<CaptureBackendVM> {
    const { sessionType, binaries, distro } = this.system;
    if (sessionType !== "x11" || !process.env.DISPLAY) {
      return this.vm(false, "Only works in an X11 session.");
    }
    if (!binaries.ffmpeg) {
      return this.vm(false, "ffmpeg is not installed.", installHint(distro, ["ffmpeg"]));
    }
    return this.vm(true);
  }

  public async listMonitors(): Promise<Monitor[]> {
    const text = this.system.binaries.xrandr ? await run(this.system.binaries.xrandr, ["--listactivemonitors"]) : null;
    return text ? parseXrandrMonitors(text) : [];
  }

  public start(request: CaptureRequest, onFrame: FrameHandler, onExit: (error: Error | null) => void): CaptureSession {
    return deferred(async () => {
      const monitors = await this.listMonitors();
      const target = monitors.find((m) => m.id === request.monitor) ?? monitors.find((m) => m.focused) ?? monitors[0];
      const input = target ? `${process.env.DISPLAY}+${target.x},${target.y}` : process.env.DISPLAY!;
      return new ProcessPipeline([[this.system.binaries.ffmpeg!, [
        "-hide_banner", "-loglevel", "info", "-nostats",
        "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(request.fps),
        ...(target ? ["-video_size", `${target.width}x${target.height}`] : []),
        "-i", input,
        "-vf", scaleFilter(request.width, request.height),
        "-f", "rawvideo", "pipe:1",
      ]]], request.width, request.height, onFrame, onExit);
    }, onExit);
  }
}
//#endregion

//#region KMS (ffmpeg kmsgrab)
/**
 * ffmpeg can read KMS planes directly when it has cap_sys_admin
 * (`sudo setcap cap_sys_admin+ep $(which ffmpeg)`). Works on AMD and Intel
 * through VA-API; not on the proprietary NVIDIA driver. Experimental.
 */
export class KmsGrabBackend extends CaptureBackend {
  public readonly id = "kmsgrab" as const;
  public readonly name = "KMS (ffmpeg kmsgrab, experimental)";

  public async check(): Promise<CaptureBackendVM> {
    const { binaries, distro } = this.system;
    if (!binaries.ffmpeg) {
      return this.vm(false, "ffmpeg is not installed.", installHint(distro, ["ffmpeg"]));
    }
    if (!await hasCapability(binaries.getcap, binaries.ffmpeg, "cap_sys_admin")) {
      return this.vm(false, "ffmpeg needs the cap_sys_admin capability to read KMS planes.", "sudo setcap cap_sys_admin+ep \"$(which ffmpeg)\"");
    }
    return this.vm(true);
  }

  public async listMonitors(): Promise<Monitor[]> {
    // kmsgrab captures the primary plane of the first active CRTC only.
    return [{ id: "default", name: "Primary display", width: 0, height: 0, x: 0, y: 0, focused: true }];
  }

  public start(request: CaptureRequest, onFrame: FrameHandler, onExit: (error: Error | null) => void): CaptureSession {
    const card = fs.readdirSync("/dev/dri").filter((f) => /^card\d+$/.test(f)).sort()[0] ?? "card0";
    return new ProcessPipeline([[this.system.binaries.ffmpeg!, [
      "-hide_banner", "-loglevel", "info", "-nostats",
      "-device", `/dev/dri/${card}`, "-f", "kmsgrab", "-framerate", String(request.fps), "-i", "-",
      "-vf", `hwmap=derive_device=vaapi,scale_vaapi=w=${request.width}:h=${request.height}:format=nv12,hwdownload,format=nv12,format=bgr0`,
      "-f", "rawvideo", "pipe:1",
    ]]], request.width, request.height, onFrame, onExit);
  }
}
//#endregion

/**
 * Start a session whose command line needs async preparation (such as asking
 * the compositor which monitor is focused), while still returning a session
 * synchronously.
 */
function deferred(prepare: () => Promise<CaptureSession>, onExit: (error: Error | null) => void): CaptureSession {
  let stopped = false;
  const session = prepare().then((s) => {
    if (stopped) void s.stop();
    return s;
  }, (error: Error) => {
    if (!stopped) onExit(error);
    return null;
  });
  return {
    async stop() {
      stopped = true;
      const s = await session;
      await s?.stop();
    },
  };
}

/**
 * Decode a binary PPM (P6) image into BGRA.
 */
export function ppmToBgra(ppm: Buffer): { width: number; height: number; bgra: Uint8Array } {
  // Header: "P6" <ws> width <ws> height <ws> maxval <single ws> data
  const header = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(ppm.subarray(0, 64).toString("latin1"));
  if (!header) throw new Error("Screenshot was not a PPM image.");
  const width = parseInt(header[1]);
  const height = parseInt(header[2]);
  const data = ppm.subarray(header[0].length);
  const bgra = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    bgra[p * 4] = data[p * 3 + 2];
    bgra[p * 4 + 1] = data[p * 3 + 1];
    bgra[p * 4 + 2] = data[p * 3];
    bgra[p * 4 + 3] = 255;
  }
  return { width, height, bgra };
}
