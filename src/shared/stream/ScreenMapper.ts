/**
 * Mapping entertainment channels onto regions of the screen.
 *
 * Each channel has a position in the room, so the colour it shows is the colour
 * of the part of the screen it sits next to: a lamp on the left wall takes the
 * left edge, one above the monitor takes the top.
 *
 * - **A point sample is too noisy.** Each channel takes a Gaussian-weighted
 *   average of a neighbourhood, so it responds to a *region*.
 * - **Not every light is near the screen.** A lamp behind the viewer has no
 *   honest screen region, so channels blend toward the whole-screen average in
 *   proportion to how far back they sit.
 *
 * **Axis convention.** Hue positions are roughly -1..1 with `x` left to right and
 * `z` bottom to top. Which end of the room holds the screen (`y`) depends on how
 * the user arranged the area, so its sign is a setting rather than a guess.
 */

/**
 * Where a channel sits in the room, in the bridge's own coordinate space.
 */
export interface ChannelPosition {
  channelId: number;
  x: number;
  y: number;
  z: number;
}

export interface MappingConfig {
  /**
   * Radius of the sampled neighbourhood, in fractions of the screen.
   */
  spread: number;
  /**
   * Which end of the room the screen is at.
   */
  screenAtPositiveY: boolean;
  /**
   * How much a channel at the very back still follows its own region rather
   * than the global average. Zero would make rear lights pure average, which
   * reads as dull.
   */
  rearRegionBlend: number;
  /**
   * Pushes sampling points toward the edge they sit nearest.
   */
  edgeBias: number;
}

export const DEFAULT_MAPPING: MappingConfig = {
  spread: 0.22,
  screenAtPositiveY: false,
  rearRegionBlend: 0.35,
  edgeBias: 0.15,
};

/**
 * Where one channel samples from, for display and debugging.
 */
export interface ChannelMapping {
  channelId: number;
  u: number;
  v: number;
  affinity: number;
}

/**
 * Turns a captured frame into one linear colour per entertainment channel.
 * Weights are precomputed once per configuration, so a frame costs one small
 * matrix multiply.
 */
export class ScreenMapper {
  public readonly config: MappingConfig;
  public readonly mappings: readonly ChannelMapping[];
  private readonly _weights: Float32Array; // channels × pixels, each row summing to 1
  private readonly _output: Float32Array;

  constructor(
    public readonly channels: readonly ChannelPosition[],
    public readonly gridWidth: number,
    public readonly gridHeight: number,
    config?: Partial<MappingConfig>,
  ) {
    this.config = { ...DEFAULT_MAPPING, ...config };
    this.mappings = channels.map((c) => this._mapChannel(c));
    this._weights = this._buildWeights();
    this._output = new Float32Array(channels.length * 3);
  }

  public get channelIds(): number[] {
    return this.channels.map((c) => c.channelId);
  }

  /**
   * Return `channels × 3` linear colours for a frame.
   * `frame` is `gridHeight × gridWidth × 3` linear floats, row-major. The
   * returned array is reused on the next call.
   */
  public sample(frame: ArrayLike<number>): Float32Array {
    const pixels = this.gridWidth * this.gridHeight;
    let meanR = 0, meanG = 0, meanB = 0;
    for (let p = 0; p < pixels; p++) {
      meanR += frame[p * 3];
      meanG += frame[p * 3 + 1];
      meanB += frame[p * 3 + 2];
    }
    meanR /= pixels;
    meanG /= pixels;
    meanB /= pixels;

    for (let c = 0; c < this.mappings.length; c++) {
      let r = 0, g = 0, b = 0;
      const row = c * pixels;
      for (let p = 0; p < pixels; p++) {
        const w = this._weights[row + p];
        r += w * frame[p * 3];
        g += w * frame[p * 3 + 1];
        b += w * frame[p * 3 + 2];
      }
      // Channels near the screen keep their own region; distant ones drift
      // toward the average, which is the honest answer for a lamp behind you.
      const a = this.mappings[c].affinity;
      this._output[c * 3] = a * r + (1 - a) * meanR;
      this._output[c * 3 + 1] = a * g + (1 - a) * meanG;
      this._output[c * 3 + 2] = a * b + (1 - a) * meanB;
    }
    return this._output;
  }

  private _mapChannel(channel: ChannelPosition): ChannelMapping {
    const { edgeBias, screenAtPositiveY, rearRegionBlend } = this.config;
    let u = unit(channel.x);
    // z is bottom-to-top but image rows run top-to-bottom.
    let v = 1 - unit(channel.z);

    // Push samples outward so a light at the edge of the room reads the edge
    // of the picture rather than something closer to centre.
    u = clamp01(0.5 + (u - 0.5) * (1 + edgeBias));
    v = clamp01(0.5 + (v - 0.5) * (1 + edgeBias));

    // depth: +1 at the screen end of the room, -1 at the far end.
    const depth = screenAtPositiveY ? channel.y : -channel.y;
    const nearness = clamp01((depth + 1) / 2);
    const affinity = rearRegionBlend + (1 - rearRegionBlend) * nearness;
    return { channelId: channel.channelId, u, v, affinity };
  }

  private _buildWeights(): Float32Array {
    const { gridWidth: w, gridHeight: h } = this;
    const weights = new Float32Array(this.mappings.length * w * h);
    const sigma = Math.max(this.config.spread, 1e-3);
    const denominator = 2 * sigma * sigma;

    this.mappings.forEach((mapping, c) => {
      const row = c * w * h;
      let total = 0;
      for (let j = 0; j < h; j++) {
        const y = (j + 0.5) / h;
        for (let i = 0; i < w; i++) {
          const x = (i + 0.5) / w;
          const weight = Math.exp(-((x - mapping.u) ** 2 + (y - mapping.v) ** 2) / denominator);
          weights[row + j * w + i] = weight;
          total += weight;
        }
      }
      // Renormalise: a kernel centred on an edge is clipped by the frame, and
      // without this those channels come out darker than the middle ones.
      if (total > 0) {
        for (let p = 0; p < w * h; p++) weights[row + p] /= total;
      }
    });
    return weights;
  }
}

/**
 * Map a -1..1 room coordinate to 0..1, tolerating out-of-range values.
 */
function unit(value: number): number {
  return clamp01((value + 1) / 2);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
