import { Check } from "lucide-react";
import type { SceneVM } from "@shared/ipc";
import { paletteGradient } from "../../lib/color";
import "./SceneTile.scss";

export interface SceneTileProps {
  scene: SceneVM;
  onRecall: (scene: SceneVM) => void;
}

export default function SceneTile(props: SceneTileProps) {
  const { scene, onRecall } = props;
  return (
    <button
      className={`bb-scene${scene.active ? " bb-scene--active" : ""}`}
      style={{ "--bb-scene-gradient": paletteGradient(scene.palette) } as React.CSSProperties}
      onClick={() => onRecall(scene)}
      title={`Apply ${scene.name}`}
    >
      <span className="bb-scene__name">{scene.name}</span>
      {scene.active && (
        <span className="bb-scene__badge" aria-label="Currently applied">
          <Check size={14} />
        </span>
      )}
    </button>
  );
}
