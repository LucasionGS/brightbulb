import { useCallback, useRef } from "react";
import { clampToGamut, hsvToRgb, rgbToHsv, rgbToXy, xyToRgb, type Gamut } from "@shared/color/convert";
import { rgbCss } from "../../lib/color";
import "./ColorWheel.scss";

export interface ColorWheelProps {
  /**
   * Current colour as CIE xy.
   */
  xy: [number, number];
  /**
   * The lamp's gamut; picks are clamped to it.
   */
  gamut: Gamut;
  onChange: (xy: [number, number]) => void;
  size?: number;
}

const HUE_STEP = 1 / 72;
const SAT_STEP = 0.05;

/**
 * Hue around the rim, saturation from the white centre outward. Brightness is
 * a separate slider, as on the lamps themselves.
 */
export default function ColorWheel(props: ColorWheelProps) {
  const { xy, gamut, onChange, size = 240 } = props;
  const ref = useRef<HTMLDivElement>(null);

  const [h, s] = rgbToHsv(xyToRgb(xy, 1, gamut));
  const rgb = xyToRgb(xy, 1, gamut);

  // Hue 0 (red) at the top, increasing clockwise, matching the conic gradient.
  const angle = h * Math.PI * 2;
  const handleX = 50 + Math.sin(angle) * s * 50;
  const handleY = 50 - Math.cos(angle) * s * 50;

  const pick = useCallback((hue: number, sat: number) => {
    const target = rgbToXy(hsvToRgb(((hue % 1) + 1) % 1, Math.min(1, Math.max(0, sat))), gamut);
    onChange(clampToGamut(target, gamut));
  }, [gamut, onChange]);

  const fromPointer = useCallback((event: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const dx = (event.clientX - rect.left) / rect.width - 0.5;
    const dy = (event.clientY - rect.top) / rect.height - 0.5;
    const hue = (Math.atan2(dx, -dy) / (Math.PI * 2) + 1) % 1;
    pick(hue, Math.min(1, Math.hypot(dx, dy) * 2));
  }, [pick]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-HUE_STEP, 0],
      ArrowRight: [HUE_STEP, 0],
      ArrowUp: [0, SAT_STEP],
      ArrowDown: [0, -SAT_STEP],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    pick(h + move[0], s + move[1]);
  };

  return (
    <div
      ref={ref}
      className="bb-wheel"
      style={{ width: size, height: size }}
      role="slider"
      tabIndex={0}
      aria-label="Colour"
      aria-valuetext={`Hue ${Math.round(h * 360)}°, saturation ${Math.round(s * 100)}%`}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        fromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons & 1) fromPointer(event);
      }}
    >
      <div className="bb-wheel__handle" style={{ left: `${handleX}%`, top: `${handleY}%`, background: rgbCss(rgb) }} />
    </div>
  );
}
