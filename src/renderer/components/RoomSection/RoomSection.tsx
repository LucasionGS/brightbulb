import type { LightVM, RoomVM } from "@shared/ipc";
import { RoomIcon } from "../../lib/icons";
import { setRoom } from "../../lib/store";
import LightCard from "../LightCard/LightCard";
import Switch from "../Switch/Switch";
import "./RoomSection.scss";

export interface RoomSectionProps {
  room: RoomVM;
  onOpenLight: (light: LightVM) => void;
}

export default function RoomSection(props: RoomSectionProps) {
  const { room, onOpenLight } = props;
  const onCount = room.lights.filter((l) => l.on).length;
  const summary = onCount === 0 ? "All off" : onCount === room.lights.length ? "All on" : `${onCount} of ${room.lights.length} on`;

  return (
    <section className="bb-room" aria-label={room.name}>
      <header className="bb-room__header">
        <div className="bb-room__icon">
          <RoomIcon archetype={room.archetype} />
        </div>
        <div className="bb-room__title">
          <h2>{room.name}</h2>
          <span>{summary}</span>
        </div>
        <Switch checked={room.anyOn} onChange={(on) => setRoom(room.id, { on })} label={`All lights in ${room.name}`} />
      </header>
      <div className="bb-room__grid">
        {room.lights.map((light) => (
          <LightCard key={light.id} light={light} onOpen={onOpenLight} />
        ))}
      </div>
    </section>
  );
}
