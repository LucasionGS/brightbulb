import { TriangleAlert } from "lucide-react";
import type { LightVM } from "@shared/ipc";
import { LightIcon } from "../../lib/icons";
import { rgbCss, vivid } from "../../lib/color";
import { setLight } from "../../lib/store";
import Slider from "../Slider/Slider";
import Switch from "../Switch/Switch";
import "./LightCard.scss";

export interface LightCardProps {
  light: LightVM;
  onOpen: (light: LightVM) => void;
}

/**
 * A light as a tile tinted by its own colour, with on/off and brightness.
 */
export default function LightCard(props: LightCardProps) {
  const { light, onOpen } = props;
  const tint = vivid(light.displayRgb);
  const hasDetails = light.brightness !== null || light.color !== null || light.temperature !== null;

  let subtitle = light.on ? (light.brightness !== null ? `On · ${light.brightness}%` : "On") : "Off";
  if (!light.reachable) subtitle += " · not responding";

  return (
    <div
      className={`bb-light${light.on ? " bb-light--on" : ""}${hasDetails ? " bb-light--clickable" : ""}`}
      style={{ "--bb-light-tint": rgbCss(tint), "--bb-light-tint-soft": rgbCss(tint, 0.42), "--bb-light-tint-faint": rgbCss(tint, 0.12) } as React.CSSProperties}
      onClick={() => hasDetails && onOpen(light)}
      onKeyDown={(event) => {
        if (hasDetails && (event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
          event.preventDefault();
          onOpen(light);
        }
      }}
      role={hasDetails ? "button" : undefined}
      tabIndex={hasDetails ? 0 : undefined}
      aria-label={hasDetails ? `${light.name}, ${subtitle}. Open details` : undefined}
    >
      <div className="bb-light__top">
        <div className="bb-light__icon">
          <LightIcon archetype={light.archetype} />
        </div>
        <div className="bb-light__text">
          <div className="bb-light__name">{light.name}</div>
          <div className="bb-light__subtitle">
            {!light.reachable && <TriangleAlert size={12} aria-hidden />}
            {subtitle}
          </div>
        </div>
        <Switch checked={light.on} onChange={(on) => setLight({ id: light.id, on })} label={`${light.name} power`} color={rgbCss(tint)} />
      </div>
      {light.brightness !== null && (
        <Slider
          compact
          label={`${light.name} brightness`}
          value={light.brightness}
          min={1}
          max={100}
          fill={light.on ? rgbCss(tint) : "var(--bb-text-dim)"}
          onChange={(brightness) => setLight({ id: light.id, brightness })}
        />
      )}
    </div>
  );
}
