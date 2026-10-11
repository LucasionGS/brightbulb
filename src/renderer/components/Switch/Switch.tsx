import { Switch as BaseSwitch } from "@base-ui/react/switch";
import "./Switch.scss";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  /**
   * Colour of the track when on. Default is the accent.
   */
  color?: string;
  size?: "md" | "lg";
}

export default function Switch(props: SwitchProps) {
  const { checked, onChange, label, disabled = false, color, size = "md" } = props;
  return (
    <BaseSwitch.Root
      className={`bb-switch bb-switch--${size}`}
      checked={checked}
      onCheckedChange={(value) => onChange(value)}
      disabled={disabled}
      aria-label={label}
      style={color ? { "--bb-switch-on": color } as React.CSSProperties : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      <BaseSwitch.Thumb className="bb-switch__thumb" />
    </BaseSwitch.Root>
  );
}
