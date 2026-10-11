/**
 * Turning captured pixels into colours worth sending to lamps.
 *
 * The chain, in order, and why each step sits where it does:
 *
 * 1. **sRGB → linear.** Screen pixels are gamma-encoded. Averaging them directly
 *    makes dark scenes too bright and desaturates everything, so all averaging
 *    happens in linear light.
 * 2. **Sample regions** (the mapper, also in linear).
 * 3. **Saturation and brightness.**
 * 4. **Temporal smoothing**, asymmetric: fast to brighten, slow to fade. A cut to
 *    a bright scene feels immediate, while noisy content does not flicker.
 * 5. **Linear → sRGB** for transmission. The bridge maps gamuts per lamp.
 */

// Rec. 709 luma weights, used to keep saturation changes from shifting brightness.
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * 256-entry sRGB byte → linear lookup table.
 */
export const SRGB_TO_LINEAR: Float32Array = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    table[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

/**
 * Convert a linear value to gamma-encoded sRGB in 0..1, clamping first.
 */
export function toSrgb(linear: number): number {
  const c = linear > 0 ? (linear < 1 ? linear : 1) : 0;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * Tunables exposed in the sync UI.
 */
export interface ProcessingSettings {
  brightness: number;
  saturation: number;
  /**
   * Per-frame blend factor when a component rises, 0..1. Higher reacts faster.
   */
  attack: number;
  /**
   * Per-frame blend factor when a component falls, 0..1.
   */
  decay: number;
  /**
   * Colours whose brightest component is below this are pushed to black, so a
   * dark scene goes properly dark instead of glowing a murky grey.
   */
  blackPoint: number;
}

export const DEFAULT_PROCESSING: ProcessingSettings = {
  brightness: 1.0,
  saturation: 1.2,
  attack: 0.6,
  decay: 0.15,
  blackPoint: 0.004,
};

/**
 * Map the single "Smoothing" slider (0 = instant, 0.95 = calm) onto attack and decay.
 */
export function smoothingToRates(smoothing: number): { attack: number; decay: number } {
  const attack = Math.max(0.05, 1 - smoothing);
  return { attack, decay: attack * 0.25 };
}

/**
 * Inverse of `smoothingToRates`, for showing the stored attack as a slider value.
 */
export function ratesToSmoothing(attack: number): number {
  return Math.min(0.95, Math.max(0, 1 - attack));
}

/**
 * Applies the colour chain and remembers smoothing state between frames.
 * All buffers are preallocated; `process()` allocates nothing.
 */
export class ColorProcessor {
  public settings: ProcessingSettings;
  private readonly _state: Float32Array;
  private readonly _output: Float32Array;
  private _primed = false;

  /**
   * @param channelCount Number of channels this processor handles.
   * @param settings Initial settings. Can be swapped at any time via `settings`.
   */
  constructor(public readonly channelCount: number, settings?: Partial<ProcessingSettings>) {
    this.settings = { ...DEFAULT_PROCESSING, ...settings };
    this._state = new Float32Array(channelCount * 3);
    this._output = new Float32Array(channelCount * 3);
  }

  /**
   * Forget smoothing state, so the next frame is used as-is.
   */
  public reset(): void {
    this._state.fill(0);
    this._primed = false;
  }

  /**
   * Take `channelCount × 3` linear colours and return sRGB in 0..1.
   * The returned array is reused on the next call.
   */
  public process(linear: ArrayLike<number>): Float32Array {
    const { saturation, brightness, blackPoint, attack, decay } = this.settings;
    const state = this._state;
    const primed = this._primed;

    for (let i = 0; i < this.channelCount; i++) {
      const o = i * 3;
      let r = linear[o], g = linear[o + 1], b = linear[o + 2];

      if (saturation !== 1) {
        // Move each colour away from its own luma-preserving grey, so raising
        // saturation does not also make everything darker.
        const grey = r * LUMA_R + g * LUMA_G + b * LUMA_B;
        r = grey + (r - grey) * saturation;
        g = grey + (g - grey) * saturation;
        b = grey + (b - grey) * saturation;
      }
      if (brightness !== 1) {
        r *= brightness;
        g *= brightness;
        b *= brightness;
      }
      r = clamp01(r);
      g = clamp01(g);
      b = clamp01(b);

      // Gate on the brightest component, not per channel, so a dim but
      // saturated colour keeps its hue instead of losing its weakest primary.
      if (blackPoint > 0 && Math.max(r, g, b) < blackPoint) {
        r = g = b = 0;
      }

      if (!primed) {
        // Start from the first real frame; easing up from black would make
        // every session begin with a visible fade-in.
        state[o] = r;
        state[o + 1] = g;
        state[o + 2] = b;
      }
      else {
        state[o] += (r - state[o]) * (r > state[o] ? attack : decay);
        state[o + 1] += (g - state[o + 1]) * (g > state[o + 1] ? attack : decay);
        state[o + 2] += (b - state[o + 2]) * (b > state[o + 2] ? attack : decay);
      }
    }
    this._primed = true;

    for (let i = 0; i < state.length; i++) {
      this._output[i] = toSrgb(state[i]);
    }
    return this._output;
  }
}

/**
 * Scale 0..1 sRGB values to the 16-bit range the protocol carries, into `out`.
 * NaN becomes 0: sending black is the safe reading of "no colour".
 */
export function toU16(srgb: ArrayLike<number>, out: Uint16Array): Uint16Array {
  for (let i = 0; i < srgb.length; i++) {
    const v = srgb[i];
    out[i] = v > 0 ? (v < 1 ? Math.floor(v * 65535 + 0.5) : 65535) : 0;
  }
  return out;
}

function clamp01(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0;
}
