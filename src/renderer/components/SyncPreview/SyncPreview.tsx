import { useEffect, useRef, useState } from "react";
import type { AreaVM, PreviewFrame } from "@shared/ipc";
import "./SyncPreview.scss";

export interface SyncPreviewProps {
  area: AreaVM;
  screenAtPositiveY: boolean;
}

/**
 * What the lights see: the sampled screen grid, and a top-down map of the
 * entertainment area with every channel in its live colour.
 */
export default function SyncPreview(props: SyncPreviewProps) {
  const { area, screenAtPositiveY } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [colors, setColors] = useState<Record<number, string>>({});

  useEffect(() => {
    void window.bb.invoke("preview:enable", true);
    const off = window.bb.onPreview((frame: PreviewFrame) => {
      const c = canvas.current;
      if (c) {
        if (c.width !== frame.width || c.height !== frame.height) {
          c.width = frame.width;
          c.height = frame.height;
        }
        c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0);
      }
      setColors(Object.fromEntries(frame.channels.map((ch) => [ch.id, `rgb(${ch.rgb.join(" ")})`])));
    });
    return () => {
      off();
      void window.bb.invoke("preview:enable", false);
    };
  }, []);

  // The screen sits at the y = -1 end unless the user flipped it; draw it at the top.
  // Positions are inset so lamps at the room's edge stay fully visible.
  const toMap = (x: number, y: number) => ({
    left: `${10 + ((clamp(x) + 1) / 2) * 80}%`,
    top: `${16 + ((screenAtPositiveY ? 1 - clamp(y) : clamp(y) + 1) / 2) * 76}%`,
  });

  return (
    <div className="bb-preview">
      <figure className="bb-preview__screen">
        <canvas ref={canvas} aria-label="Captured screen colours" />
        <figcaption>What is sampled</figcaption>
      </figure>
      <figure className="bb-preview__map">
        <div className="bb-preview__room">
          <div className="bb-preview__tv" />
          {area.channels.map((channel) => (
            <div
              key={channel.id}
              className="bb-preview__dot"
              style={{ ...toMap(channel.x, channel.y), "--bb-dot": colors[channel.id] ?? "var(--bb-surface-active)" } as React.CSSProperties}
              title={`Channel ${channel.id}`}
            />
          ))}
        </div>
        <figcaption>{area.name}, from above</figcaption>
      </figure>
    </div>
  );
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
