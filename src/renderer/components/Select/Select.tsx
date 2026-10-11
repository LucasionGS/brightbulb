import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import "./Select.scss";

export interface SelectOption {
  value: string;
  label: string;
  /**
   * Second line under the label.
   */
  hint?: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string | null;
  options: SelectOption[];
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
}

export default function Select(props: SelectProps) {
  const { value, options, onChange, label, placeholder = "Choose…", disabled = false } = props;
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(v) => {
        if (typeof v === "string") onChange(v);
      }}
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      disabled={disabled}
    >
      <BaseSelect.Trigger className="bb-select__trigger" aria-label={label}>
        <BaseSelect.Value className="bb-select__value" placeholder={placeholder} />
        <BaseSelect.Icon className="bb-select__icon">
          <ChevronDown size={16} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="bb-select__positioner" sideOffset={6} alignItemWithTrigger={false}>
          <BaseSelect.Popup className="bb-select__popup">
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item key={option.value} value={option.value} disabled={option.disabled} className="bb-select__item">
                  <div className="bb-select__item-text">
                    <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                    {option.hint && <span className="bb-select__hint">{option.hint}</span>}
                  </div>
                  <BaseSelect.ItemIndicator className="bb-select__check">
                    <Check size={16} />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
