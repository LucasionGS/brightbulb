import type { RGB } from "@shared/ipc";

/**
 * CSS `rgb()` for a 0-1 colour, with optional alpha.
 */
export function rgbCss(rgb: readonly number[], alpha = 1): string {
  const [r, g, b] = rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

/**
 * Brighten a colour toward full value while keeping its hue, so very dark
 * colours still read as a tint.
 */
export function vivid(rgb: RGB): RGB {
  const max = Math.max(...rgb);
  if (max <= 0) return [1, 0.84, 0.62];
  return rgb.map((c) => c / max) as RGB;
}

/**
 * Relative luminance, for choosing readable text on a coloured background.
 */
export function luminance(rgb: readonly number[]): number {
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * A CSS gradient through a scene palette.
 */
export function paletteGradient(palette: RGB[], angle = 135): string {
  if (palette.length === 0) return "linear-gradient(135deg, #2a3142, #1c212c)";
  if (palette.length === 1) return `linear-gradient(${angle}deg, ${rgbCss(palette[0])}, ${rgbCss(palette[0].map((c) => c * 0.55))})`;
  return `linear-gradient(${angle}deg, ${palette.map((c, i) => `${rgbCss(c)} ${Math.round((i / (palette.length - 1)) * 100)}%`).join(", ")})`;
}
