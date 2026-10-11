import { useState } from "react";
import { Lightbulb } from "lucide-react";
import type { AppSnapshot } from "@shared/ipc";
import EmptyState from "../../components/EmptyState/EmptyState";
import LightSheet from "../../components/LightSheet/LightSheet";
import RoomSection from "../../components/RoomSection/RoomSection";

export interface LightsProps {
  snapshot: AppSnapshot;
}

export default function Lights(props: LightsProps) {
  const { snapshot } = props;
  const [openId, setOpenId] = useState<string | null>(null);
  const lights = snapshot.rooms.flatMap((r) => r.lights);
  // Look the light up on every render, so the sheet follows live changes.
  const open = lights.find((l) => l.id === openId) ?? null;
  const onCount = lights.filter((l) => l.on).length;

  if (lights.length === 0) {
    return (
      <div className="bb-page">
        <EmptyState icon={Lightbulb} title="No lights yet" description="Lights you add in the Hue app appear here." />
      </div>
    );
  }

  return (
    <div className="bb-page">
      <header className="bb-page-header">
        <div>
          <h1>Lights</h1>
          <p>{onCount === 0 ? "Everything is off" : `${onCount} of ${lights.length} lights on`}</p>
        </div>
      </header>
      {snapshot.rooms.map((room) => (
        <RoomSection key={room.id} room={room} onOpenLight={(light) => setOpenId(light.id)} />
      ))}
      <LightSheet light={open} onClose={() => setOpenId(null)} />
    </div>
  );
}
