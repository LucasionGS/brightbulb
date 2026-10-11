import { useEffect, useState } from "react";
import { Monitor as MonitorIcon, RefreshCw, ScanEye } from "lucide-react";
import type { Monitor } from "@shared/ipc";
import "./MonitorPicker.scss";

export interface MonitorPickerProps {
  /**
   * Selected monitor id, or null for automatic (the focused one).
   */
  selected: string | null;
  onSelect: (id: string | null) => void;
  /**
   * Changes whenever the monitor list should be reloaded (e.g. the capture method).
   */
  reloadKey: string;
}

export default function MonitorPicker(props: MonitorPickerProps) {
  const { selected, onSelect, reloadKey } = props;
  const { monitors, thumbnails, loading, error, reload } = useMonitors(reloadKey);

  if (monitors.length === 1 && monitors[0].id === "portal") {
    return <p className="bb-muted">The system will ask which screen to share when mirroring starts.</p>;
  }

  return (
    <div className="bb-monitors">
      <div className="bb-monitors__grid" role="radiogroup" aria-label="Screen to mirror">
        <button
          className={`bb-monitor${selected === null ? " bb-monitor--selected" : ""}`}
          role="radio"
          aria-checked={selected === null}
          onClick={() => onSelect(null)}
        >
          <div className="bb-monitor__thumb bb-monitor__thumb--auto">
            <ScanEye size={28} />
          </div>
          <div className="bb-monitor__name">Automatic</div>
          <div className="bb-monitor__meta">The focused screen</div>
        </button>
        {monitors.map((monitor) => (
          <button
            key={monitor.id}
            className={`bb-monitor${selected === monitor.id ? " bb-monitor--selected" : ""}`}
            role="radio"
            aria-checked={selected === monitor.id}
            onClick={() => onSelect(monitor.id)}
          >
            <div className="bb-monitor__thumb" style={monitor.width && monitor.height ? { aspectRatio: `${monitor.width} / ${monitor.height}` } : undefined}>
              {thumbnails[monitor.id]
                ? <img src={thumbnails[monitor.id]} alt="" draggable={false} />
                : <MonitorIcon size={24} />}
            </div>
            <div className="bb-monitor__name">{monitor.id}</div>
            <div className="bb-monitor__meta">
              {monitor.width ? `${monitor.width}×${monitor.height}` : monitor.name}
              {monitor.focused && " · focused"}
            </div>
          </button>
        ))}
      </div>
      <div className="bb-monitors__footer">
        {error && <span className="bb-dim">{error}</span>}
        <button className="bb-btn bb-btn--ghost bb-btn--sm" onClick={reload} disabled={loading}>
          <RefreshCw size={14} className={loading ? "bb-spin" : undefined} /> Refresh
        </button>
      </div>
    </div>
  );
}

function useMonitors(reloadKey: string) {
  const [nonce, setNonce] = useState(0);
  const requestKey = `${reloadKey}#${nonce}`;
  const [state, setState] = useState<{ key: string | null; monitors: Monitor[]; thumbnails: Record<string, string>; error: string | null }>(
    { key: null, monitors: [], thumbnails: {}, error: null },
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await window.bb.invoke("capture:listMonitors");
      if (cancelled) return;
      if (!list.ok) {
        setState((s) => ({ ...s, key: requestKey, error: list.message }));
        return;
      }
      // Show the list straight away; thumbnails take a moment longer.
      setState((s) => ({ ...s, monitors: list.value, error: null }));
      const ids = list.value.filter((m) => m.id !== "portal" && m.id !== "default").map((m) => m.id);
      const thumbs = ids.length ? await window.bb.invoke("capture:thumbnails", ids) : null;
      if (cancelled) return;
      setState((s) => ({
        ...s,
        key: requestKey,
        thumbnails: thumbs?.ok ? Object.fromEntries(thumbs.value.map((t) => [t.id, t.dataUrl])) : s.thumbnails,
      }));
    })();
    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  return {
    monitors: state.monitors,
    thumbnails: state.thumbnails,
    error: state.error,
    loading: state.key !== requestKey,
    reload: () => setNonce((n) => n + 1),
  };
}
