import type { LightVM } from "@shared/ipc";
import { mirekToRgb } from "@shared/color/convert";
import { rgbCss, vivid } from "../../lib/color";
import { setLight } from "../../lib/store";
import ColorWheel from "../ColorWheel/ColorWheel";
import Sheet from "../Sheet/Sheet";
import Slider from "../Slider/Slider";
import Switch from "../Switch/Switch";
import "./LightSheet.scss";

export interface LightSheetProps {
  light: LightVM | null;
  onClose: () => void;
}

// The white settings Hue's own app offers, in mireds.
const WHITE_PRESETS = [
  { name: "Relax", mirek: 447 },
  { name: "Read", mirek: 346 },
  { name: "Concentrate", mirek: 233 },
  { name: "Energize", mirek: 156 },
];

/**
 * Detailed controls for one light: brightness, colour and white temperature.
 */
export default function LightSheet(props: LightSheetProps) {
  const { light, onClose } = props;
  const tint = light ? rgbCss(vivid(light.displayRgb)) : undefined;

  return (
    <Sheet open={light !== null} onClose={onClose} title={light?.name ?? ""} description={light?.reachable === false ? "The bridge cannot reach this light. It may be switched off at the wall." : undefined} accent={tint}>
      {light && (
        <>
          <div className="bb-light-sheet__power">
            <span>{light.on ? "On" : "Off"}</span>
            <Switch checked={light.on} onChange={(on) => setLight({ id: light.id, on })} label="Power" size="lg" color={tint} />
          </div>

          {light.brightness !== null && (
            <Slider
              label="Brightness"
              value={light.brightness}
              min={1}
              max={100}
              format={(v) => `${Math.round(v)}%`}
              track={`linear-gradient(90deg, rgb(20 20 24), ${tint})`}
              onChange={(brightness) => setLight({ id: light.id, brightness })}
            />
          )}

          {light.color && (
            <div className="bb-light-sheet__wheel">
              <ColorWheel
                xy={light.color.xy}
                gamut={{
                  red: { x: light.color.gamut.red[0], y: light.color.gamut.red[1] },
                  green: { x: light.color.gamut.green[0], y: light.color.gamut.green[1] },
                  blue: { x: light.color.gamut.blue[0], y: light.color.gamut.blue[1] },
                }}
                onChange={(xy) => setLight({ id: light.id, xy })}
              />
            </div>
          )}

          {light.temperature && (
            <div className="bb-light-sheet__white">
              <Slider
                label="White"
                value={light.temperature.mirek ?? Math.round((light.temperature.min + light.temperature.max) / 2)}
                min={light.temperature.min}
                max={light.temperature.max}
                format={(v) => `${Math.round(1_000_000 / v / 50) * 50} K`}
                track={`linear-gradient(90deg, ${rgbCss(mirekToRgb(light.temperature.min))}, ${rgbCss(mirekToRgb((light.temperature.min + light.temperature.max) / 2))}, ${rgbCss(mirekToRgb(light.temperature.max))})`}
                onChange={(mirek) => setLight({ id: light.id, mirek })}
              />
              <div className="bb-light-sheet__presets">
                {WHITE_PRESETS.filter((p) => p.mirek >= light.temperature!.min && p.mirek <= light.temperature!.max).map((preset) => (
                  <button
                    key={preset.name}
                    className="bb-light-sheet__preset"
                    style={{ "--bb-preset": rgbCss(mirekToRgb(preset.mirek)) } as React.CSSProperties}
                    onClick={() => setLight({ id: light.id, mirek: preset.mirek })}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
