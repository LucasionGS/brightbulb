import { Sparkles } from "lucide-react";
import type { AppSnapshot, SceneVM } from "@shared/ipc";
import EmptyState from "../../components/EmptyState/EmptyState";
import SceneTile from "../../components/SceneTile/SceneTile";
import { toast } from "../../components/Toasts/Toasts";
import "./Scenes.scss";

export interface ScenesProps {
  snapshot: AppSnapshot;
}

export default function Scenes(props: ScenesProps) {
  const { snapshot } = props;

  async function recall(scene: SceneVM) {
    const result = await window.bb.invoke("scene:recall", scene.id);
    if (result.ok) toast(`Applied ${scene.name}`, { type: "success" });
    else toast(`Could not apply ${scene.name}`, { description: result.message, type: "error" });
  }

  if (snapshot.sceneGroups.length === 0) {
    return (
      <div className="bb-page">
        <EmptyState icon={Sparkles} title="No scenes" description="Scenes you create in the Hue app appear here." />
      </div>
    );
  }

  return (
    <div className="bb-page">
      <header className="bb-page-header">
        <div>
          <h1>Scenes</h1>
          <p>Tap a scene to apply it.</p>
        </div>
      </header>
      {snapshot.sceneGroups.map((group, i) => (
        <section key={`${i}-${group.name}`} className="bb-scenes__group" aria-label={group.name}>
          <h2 className="bb-section-title">{group.name}</h2>
          <div className="bb-scenes__grid">
            {group.scenes.map((scene) => <SceneTile key={scene.id} scene={scene} onRecall={recall} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
