import { LoaderCircle, TriangleAlert } from "lucide-react";
import type { ConnectionVM } from "@shared/ipc";
import "./ConnectionBanner.scss";

export interface ConnectionBannerProps {
  connection: ConnectionVM;
  onOpenSettings: () => void;
}

/**
 * Explains why the bridge is not connected, with the action that fixes it.
 */
export default function ConnectionBanner(props: ConnectionBannerProps) {
  const { connection, onOpenSettings } = props;
  if (connection.state === "connected" || !connection.bridge) return null;

  if (connection.state === "connecting") {
    return (
      <div className="bb-banner">
        <LoaderCircle size={18} className="bb-spin" />
        <span>Connecting to {connection.bridge.name}…</span>
      </div>
    );
  }

  return (
    <div className="bb-banner bb-banner--problem" role="alert">
      <TriangleAlert size={18} />
      <span className="bb-banner__text">{connection.detail ?? "Not connected to the bridge."}</span>
      {connection.state === "unauthorized" && (
        <button className="bb-btn bb-btn--sm bb-btn--primary" onClick={() => void window.bb.invoke("discovery:start")}>Pair again</button>
      )}
      {connection.code === "cert-changed" && (
        <button className="bb-btn bb-btn--sm" onClick={onOpenSettings}>Review</button>
      )}
      {connection.state === "error" && connection.code === null && (
        <button className="bb-btn bb-btn--sm" onClick={() => void window.bb.invoke("bridge:reconnect")}>Retry now</button>
      )}
    </div>
  );
}
