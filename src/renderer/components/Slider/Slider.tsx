import { Slider as BaseSlider } from "@base-ui/react/slider";
import "./Slider.scss";

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  /**
   * Called continuously while dragging.
   */
  onChange: (value: number) => void;
  /**
   * Called once when the drag ends.
   */
  onCommit?: (value: number) => void;
  /**
   * CSS background for the whole track (e.g. a warm-to-cool gradient).
   * Without it, the filled part uses `fill`.
   */
  track?: string;
  /**
   * Colour of the filled part. Default is the accent.
   */
  fill?: string;
  /**
   * Show the value text next to the label, formatted by this function.
   */
  format?: (value: number) => string;
  disabled?: boolean;
  /**
   * Hide the label row (the label is still read by screen readers).
   */
  compact?: boolean;
}

export default function Slider(props: SliderProps) {
  const { value, min, max, step = 1, label, onChange, onCommit, track, fill, format, disabled = false, compact = false } = props;
  return (
    <div className={`bb-slider${compact ? " bb-slider--compact" : ""}`} onClick={(event) => event.stopPropagation()}>
      {!compact && (
        <div className="bb-slider__label">
          <span>{label}</span>
          {format && <span className="bb-slider__value">{format(value)}</span>}
        </div>
      )}
      <BaseSlider.Root
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={(v) => onChange(v as number)}
        onValueCommitted={(v) => onCommit?.(v as number)}
        style={{ "--bb-slider-track": track ?? "var(--bb-surface-active)", "--bb-slider-fill": fill ?? "var(--bb-accent)" } as React.CSSProperties}
      >
        <BaseSlider.Control className="bb-slider__control">
          <BaseSlider.Track className={`bb-slider__track${track ? " bb-slider__track--gradient" : ""}`}>
            {!track && <BaseSlider.Indicator className="bb-slider__indicator" />}
            <BaseSlider.Thumb className="bb-slider__thumb" aria-label={label} />
          </BaseSlider.Track>
        </BaseSlider.Control>
      </BaseSlider.Root>
    </div>
  );
}
