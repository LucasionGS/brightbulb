/**
 * Conversion between sRGB, CIE xy and colour temperature.
 *
 * The Hue API speaks CIE xy chromaticity; the UI speaks sRGB. Every lamp model
 * has a different *gamut* (the triangle of colours it can produce), and asking
 * for a colour outside it gives something visibly wrong rather than an error, so
 * requested colours are clamped to the lamp's own triangle first.
 *
 * Matrices and gamut corners follow Signify's published conversion for Hue
 * lamps, which uses a Wide-RGB D65 primary set rather than plain sRGB.
 */

export type RGB = [number, number, number];
export type XY = [number, number];

export interface Point {
  x: number;
  y: number;
}

/**
 * The triangle of colours a lamp can reproduce.
 */
export interface Gamut {
  red: Point;
  green: Point;
  blue: Point;
}

// A: original Hue bulbs. B: later bulbs and Lightstrips. C: current colour lamps.
export const GAMUT_A: Gamut = { red: { x: 0.704, y: 0.296 }, green: { x: 0.2151, y: 0.7106 }, blue: { x: 0.138, y: 0.08 } };
export const GAMUT_B: Gamut = { red: { x: 0.675, y: 0.322 }, green: { x: 0.409, y: 0.518 }, blue: { x: 0.167, y: 0.04 } };
export const GAMUT_C: Gamut = { red: { x: 0.692, y: 0.308 }, green: { x: 0.17, y: 0.7 }, blue: { x: 0.153, y: 0.048 } };

/**
 * Fallback for lamps that report no gamut: the widest, so nothing is clipped
 * more than the lamp itself will clip it.
 */
export const DEFAULT_GAMUT = GAMUT_C;

/**
 * Map a Hue `gamut_type` ("A"/"B"/"C") to its triangle. Anything unrecognised
 * falls back to the widest gamut, so a new lamp family never breaks the list.
 */
export function gamutFor(gamutType: unknown): Gamut {
  if (typeof gamutType !== "string") return DEFAULT_GAMUT;
  switch (gamutType.toUpperCase()) {
    case "A": return GAMUT_A;
    case "B": return GAMUT_B;
    case "C": return GAMUT_C;
    default: return DEFAULT_GAMUT;
  }
}

function gammaExpand(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function gammaCompress(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * Convert sRGB (0-1 per channel) to a CIE xy point inside `gamut`.
 */
export function rgbToXy(rgb: readonly number[], gamut: Gamut = DEFAULT_GAMUT): XY {
  const [r, g, b] = rgb.map((c) => gammaExpand(clamp01(c)));
  const X = r * 0.649926 + g * 0.103455 + b * 0.197109;
  const Y = r * 0.234327 + g * 0.743075 + b * 0.022598;
  const Z = g * 0.053077 + b * 1.035763;

  const total = X + Y + Z;
  if (total === 0) {
    // Pure black has no chromaticity; report the gamut's red corner and let
    // brightness carry the "off" meaning.
    return [gamut.red.x, gamut.red.y];
  }
  return clampToGamut([X / total, Y / total], gamut);
}

/**
 * Convert a CIE xy point plus brightness (0-1) to sRGB (0-1 per channel).
 */
export function xyToRgb(xy: readonly number[], brightness = 1, gamut: Gamut = DEFAULT_GAMUT): RGB {
  const [x, y] = clampToGamut([xy[0], xy[1]], gamut);
  if (y === 0) return [0, 0, 0];

  const Y = clamp01(brightness);
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);

  // The matrix can produce small negatives for in-gamut colours; clip before
  // gamma or the curve returns NaN.
  const channels = [
    X * 1.4628067 - Y * 0.1840623 - Z * 0.2743606,
    -X * 0.5217933 + Y * 1.4472381 + Z * 0.0677227,
    X * 0.0349342 - Y * 0.0968930 + Z * 1.2884099,
  ].map((c) => Math.max(0, c));

  // Rescale rather than clip on overflow, so hue is kept instead of drifting to white.
  const peak = Math.max(...channels);
  const scaled = peak > 1 ? channels.map((c) => c / peak) : channels;
  return scaled.map((c) => clamp01(gammaCompress(c))) as RGB;
}

/**
 * Return `xy` if the lamp can produce it, otherwise the nearest point it can.
 */
export function clampToGamut(xy: XY, gamut: Gamut = DEFAULT_GAMUT): XY {
  const point = { x: xy[0], y: xy[1] };
  if (inTriangle(point, gamut)) return [point.x, point.y];

  const candidates = [
    closestOnSegment(gamut.red, gamut.green, point),
    closestOnSegment(gamut.green, gamut.blue, point),
    closestOnSegment(gamut.blue, gamut.red, point),
  ];
  let nearest = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (distance(candidate, point) < distance(nearest, point)) nearest = candidate;
  }
  return [nearest.x, nearest.y];
}

/**
 * Approximate the visible colour of a white setting given in mireds.
 * Only used to tint the UI; lamps are always driven by the mired value itself.
 */
export function mirekToRgb(mirek: number): RGB {
  const temp = 1_000_000 / Math.max(1, mirek) / 100;
  let red: number, green: number, blue: number;

  if (temp <= 66) {
    red = 255;
    green = temp > 0 ? 99.4708025861 * Math.log(temp) - 161.1195681661 : 0;
  }
  else {
    red = 329.698727446 * (temp - 60) ** -0.1332047592;
    green = 288.1221695283 * (temp - 60) ** -0.0755148492;
  }

  if (temp >= 66) {
    blue = 255;
  }
  else if (temp <= 19) {
    blue = 0;
  }
  else {
    blue = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  }
  return [clamp01(red / 255), clamp01(green / 255), clamp01(blue / 255)];
}

/**
 * Hue (0-1) and saturation (0-1) at full value, to sRGB. Used by the colour wheel.
 */
export function hsvToRgb(h: number, s: number, v = 1): RGB {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/**
 * sRGB to hue/saturation/value, each 0-1. Used to place the colour wheel handle.
 */
export function rgbToHsv(rgb: readonly number[]): [number, number, number] {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

/**
 * Format 0-1 RGB as a CSS `rgb()` string.
 */
export function cssRgb(rgb: readonly number[]): string {
  return `rgb(${rgb.map((c) => Math.round(clamp01(c) * 255)).join(" ")})`;
}

// Points landing exactly on an edge, which is precisely what clampToGamut
// produces, can fall a fraction outside in floating point.
const TRIANGLE_EPSILON = 1e-9;

function inTriangle(point: Point, gamut: Gamut): boolean {
  const v1 = { x: gamut.green.x - gamut.red.x, y: gamut.green.y - gamut.red.y };
  const v2 = { x: gamut.blue.x - gamut.red.x, y: gamut.blue.y - gamut.red.y };
  const q = { x: point.x - gamut.red.x, y: point.y - gamut.red.y };

  const denominator = v1.x * v2.y - v2.x * v1.y;
  if (denominator === 0) return false;

  const s = (q.x * v2.y - v2.x * q.y) / denominator;
  const t = (v1.x * q.y - q.x * v1.y) / denominator;
  return s >= -TRIANGLE_EPSILON && t >= -TRIANGLE_EPSILON && s + t <= 1 + TRIANGLE_EPSILON;
}

function closestOnSegment(start: Point, end: Point, point: Point): Point {
  const ap = { x: point.x - start.x, y: point.y - start.y };
  const ab = { x: end.x - start.x, y: end.y - start.y };
  const abSquared = ab.x * ab.x + ab.y * ab.y;
  if (abSquared === 0) return start;
  const t = Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y) / abSquared));
  return { x: start.x + ab.x * t, y: start.y + ab.y * t };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
