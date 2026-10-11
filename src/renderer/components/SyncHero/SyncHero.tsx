import { Power } from "lucide-react";
import type { SyncVM } from "@shared/ipc";
import "./SyncHero.scss";

export interface SyncHeroProps {
  sync: SyncVM;
  canStart: boolean;
  onToggle: () => void;
}

/**
 * The big mirror toggle with live status.
 */
export default function SyncHero(props: SyncHeroProps) {
  const { sync, canStart, onToggle } = props;
  const active = sync.phase === "starting" || sync.phase === "streaming";
  const busy = sync.phase === "starting" || sync.phase === "stopping";
  const stats = sync.stats;

  let detail = sync.status;
  if (sync.phase === "streaming" && stats) {
    detail = `${stats.fps} fps · ${stats.lights} light${stats.lights === 1 ? "" : "s"}`;
  }

  return (
    <div className={`bb-sync-hero bb-sync-hero--${sync.phase}`}>
      <button
        className="bb-sync-hero__button"
        onClick={onToggle}
        disabled={!active && !canStart}
        aria-pressed={active}
        aria-label={active ? "Stop mirroring" : "Start mirroring"}
      >
        <span className="bb-sync-hero__ring" aria-hidden />
        <Power size={40} strokeWidth={2.4} />
      </button>
      <div className="bb-sync-hero__text">
        <h1>{sync.phase === "streaming" ? "Mirroring your screen" : active ? "Starting…" : "Mirror your screen"}</h1>
        <p className={busy ? "bb-sync-hero__busy" : undefined}>{detail}</p>
        {sync.phase === "streaming" && stats && (
          <p className="bb-dim bb-sync-hero__stats">
            Capture {stats.captureFps} fps · frame timing p99 {stats.p99IntervalMs} ms{sync.activeBackend ? ` · ${sync.activeBackend}` : ""}
          </p>
        )}
        {sync.error && <p className="bb-sync-hero__error" role="alert">{sync.error}</p>}
      </div>
    </div>
  );
}
