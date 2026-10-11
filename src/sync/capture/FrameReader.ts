/**
 * Reassembling raw video frames from a capture process's stdout.
 *
 * Every backend ends in ffmpeg's `rawvideo` muxer, which writes tightly packed
 * frames back to back. The pixel format is requested explicitly (`bgr0`), but
 * wf-recorder has been seen to pick its own, so the format ffmpeg actually
 * chose is read from its stderr banner before any frame is interpreted.
 */
import { SRGB_TO_LINEAR } from "@shared/color/process";

/**
 * Where the colour components sit within one pixel.
 */
export interface PixelLayout {
  format: string;
  bytesPerPixel: number;
  r: number;
  g: number;
  b: number;
}

const LAYOUTS: Record<string, [number, number, number, number]> = {
  // format: [bytesPerPixel, r, g, b]
  bgr0: [4, 2, 1, 0],
  bgra: [4, 2, 1, 0],
  rgb0: [4, 0, 1, 2],
  rgba: [4, 0, 1, 2],
  "0rgb": [4, 1, 2, 3],
  argb: [4, 1, 2, 3],
  "0bgr": [4, 3, 2, 1],
  abgr: [4, 3, 2, 1],
  rgb24: [3, 0, 1, 2],
  bgr24: [3, 2, 1, 0],
};

export function layoutFor(format: string): PixelLayout | null {
  const entry = LAYOUTS[format.toLowerCase()];
  return entry ? { format: format.toLowerCase(), bytesPerPixel: entry[0], r: entry[1], g: entry[2], b: entry[3] } : null;
}

export const DEFAULT_LAYOUT = layoutFor("bgr0")!;

/**
 * Find the output stream description in ffmpeg's stderr.
 */
export function parseStreamInfo(text: string): { format: string; width: number; height: number } | null {
  // Example (the output stream; the input stream is listed first and ignored):
  // Output #0, rawvideo, to '/dev/stdout':
  //   Stream #0:0: Video: rawvideo (BGR[0] / 0x524742), bgr0(pc), 64x36 [SAR 1:1 DAR 16:9], q=2-31, 3317 kb/s
  const output = text.indexOf("Output #0");
  if (output === -1) return null;
  const match = /Video: rawvideo[^,]*, (\w+)(?:\([^)]*\))?, (\d+)x(\d+)/.exec(text.slice(output));
  return match ? { format: match[1], width: parseInt(match[2]), height: parseInt(match[3]) } : null;
}

/**
 * Collects stdout chunks into complete frames.
 * Frames are delivered as views into an internal buffer, valid only until the
 * callback returns.
 */
export class FrameReader {
  private _layout: PixelLayout | null;
  private _buffer: Buffer;
  private _filled = 0;
  private _stderr = "";
  private _pending: Buffer[] = [];
  private _fallbackTimer: NodeJS.Timeout | null = null;

  /**
   * @param width Frame width in pixels.
   * @param height Frame height in pixels.
   * @param onFrame Called with each complete frame.
   * @param knownLayout Skip stderr detection and assume this layout.
   */
  constructor(
    public readonly width: number,
    public readonly height: number,
    private readonly onFrame: (frame: Buffer, layout: PixelLayout) => void,
    knownLayout: PixelLayout | null = null,
  ) {
    this._layout = knownLayout;
    this._buffer = Buffer.alloc(width * height * (knownLayout?.bytesPerPixel ?? 4));
    if (!knownLayout) {
      // If the banner never shows up (unusual logging settings), assume what was asked for.
      this._fallbackTimer = setTimeout(() => this._setLayout(DEFAULT_LAYOUT), 1500);
    }
  }

  public get layout(): PixelLayout | null {
    return this._layout;
  }

  public pushStderr(chunk: Buffer | string): void {
    if (this._layout) return;
    this._stderr += chunk.toString();
    const info = parseStreamInfo(this._stderr);
    if (info) {
      const layout = layoutFor(info.format);
      if (!layout) {
        console.warn(`Capture produced unsupported pixel format ${info.format}; assuming bgr0.`);
      }
      this._setLayout(layout ?? DEFAULT_LAYOUT);
    }
    else if (this._stderr.length > 65536) {
      this._stderr = this._stderr.slice(-16384);
    }
  }

  public pushStdout(chunk: Buffer): void {
    if (!this._layout) {
      this._pending.push(chunk);
      return;
    }
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(this._buffer.length - this._filled, chunk.length - offset);
      chunk.copy(this._buffer, this._filled, offset, offset + take);
      this._filled += take;
      offset += take;
      if (this._filled === this._buffer.length) {
        this._filled = 0;
        this.onFrame(this._buffer, this._layout);
      }
    }
  }

  public dispose(): void {
    if (this._fallbackTimer) clearTimeout(this._fallbackTimer);
    this._fallbackTimer = null;
  }

  private _setLayout(layout: PixelLayout): void {
    if (this._layout) return;
    this.dispose();
    this._layout = layout;
    this._buffer = Buffer.alloc(this.width * this.height * layout.bytesPerPixel);
    const pending = this._pending;
    this._pending = [];
    for (const chunk of pending) this.pushStdout(chunk);
  }
}

/**
 * Convert one packed frame to linear RGB floats (`w × h × 3`) via the sRGB LUT.
 */
export function frameToLinear(frame: Uint8Array, layout: PixelLayout, out: Float32Array): Float32Array {
  const { bytesPerPixel: bpp, r, g, b } = layout;
  const pixels = out.length / 3;
  for (let p = 0; p < pixels; p++) {
    const i = p * bpp;
    out[p * 3] = SRGB_TO_LINEAR[frame[i + r]];
    out[p * 3 + 1] = SRGB_TO_LINEAR[frame[i + g]];
    out[p * 3 + 2] = SRGB_TO_LINEAR[frame[i + b]];
  }
  return out;
}

/**
 * Convert one packed frame to RGBA bytes for display.
 */
export function frameToRgba(frame: Uint8Array, layout: PixelLayout, out: Uint8ClampedArray): Uint8ClampedArray {
  const { bytesPerPixel: bpp, r, g, b } = layout;
  const pixels = out.length / 4;
  for (let p = 0; p < pixels; p++) {
    const i = p * bpp;
    out[p * 4] = frame[i + r];
    out[p * 4 + 1] = frame[i + g];
    out[p * 4 + 2] = frame[i + b];
    out[p * 4 + 3] = 255;
  }
  return out;
}

/**
 * Convert one packed frame to BGRA bytes, as `nativeImage.createFromBitmap` expects.
 */
export function frameToBgra(frame: Uint8Array, layout: PixelLayout, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const { bytesPerPixel: bpp, r, g, b } = layout;
  for (let p = 0; p < width * height; p++) {
    const i = p * bpp;
    out[p * 4] = frame[i + b];
    out[p * 4 + 1] = frame[i + g];
    out[p * 4 + 2] = frame[i + r];
    out[p * 4 + 3] = 255;
  }
  return out;
}
