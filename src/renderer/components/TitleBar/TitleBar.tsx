import { Lightbulb, Minus, MonitorPlay, Settings, Sparkles, Square, X } from "lucide-react";
import type { ConnectionVM } from "@shared/ipc";
import "./TitleBar.scss";

export type Tab = "lights" | "scenes" | "sync" | "settings";

export const TABS: { id: Tab; label: string; icon: typeof Lightbulb }[] = [
  { id: "lights", label: "Lights", icon: Lightbulb },
  { id: "scenes", label: "Scenes", icon: Sparkles },
  { id: "sync", label: "Sync", icon: MonitorPlay },
  { id: "settings", label: "Settings", icon: Settings },
];

const CONNECTION_TEXT: Record<ConnectionVM["state"], string> = {
  connected: "Connected",
  connecting: "Connecting",
  error: "Offline",
  unauthorized: "Access revoked",
  disconnected: "No bridge",
};

export interface TitleBarProps {
  tab: Tab;
  onTab: (tab: Tab) => void;
  connection: ConnectionVM;
  showTabs: boolean;
  mirroring: boolean;
}

/**
 * The window's own title bar: drag area, page tabs and window controls.
 */
export default function TitleBar(props: TitleBarProps) {
  const { tab, onTab, connection, showTabs, mirroring } = props;
  return (
    <header className="bb-titlebar">
      <div className="bb-titlebar__brand">
        <span className="bb-titlebar__logo"><Lightbulb size={16} /></span>
        <span>BrightBulb</span>
      </div>

      {showTabs && (
        <nav className="bb-titlebar__tabs" aria-label="Pages">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`bb-titlebar__tab${tab === id ? " bb-titlebar__tab--active" : ""}`} onClick={() => onTab(id)} aria-current={tab === id ? "page" : undefined}>
              <Icon size={16} />
              <span>{label}</span>
              {id === "sync" && mirroring && <span className="bb-titlebar__live" aria-label="Mirroring" />}
            </button>
          ))}
        </nav>
      )}

      <div className="bb-titlebar__end">
        {connection.bridge && (
          <button className={`bb-titlebar__status bb-titlebar__status--${connection.state}`} onClick={() => onTab("settings")} title={connection.detail ?? CONNECTION_TEXT[connection.state]}>
            <span className="bb-titlebar__dot" />
            <span className="bb-titlebar__status-text">{CONNECTION_TEXT[connection.state]}</span>
          </button>
        )}
        <div className="bb-titlebar__controls">
          <button onClick={() => void window.bb.invoke("window:minimize")} aria-label="Minimize"><Minus size={16} /></button>
          <button onClick={() => void window.bb.invoke("window:toggleMaximize")} aria-label="Maximize"><Square size={13} /></button>
          <button className="bb-titlebar__close" onClick={() => void window.bb.invoke("window:close")} aria-label="Close"><X size={17} /></button>
        </div>
      </div>
    </header>
  );
}

/**
 * Page tabs along the bottom, for narrow windows.
 */
export function BottomNav(props: { tab: Tab; onTab: (tab: Tab) => void }) {
  const { tab, onTab } = props;
  return (
    <nav className="bb-bottomnav" aria-label="Pages">
      {TABS.map(({ id, label, icon: Icon }) => (
        <button key={id} className={`bb-bottomnav__tab${tab === id ? " bb-bottomnav__tab--active" : ""}`} onClick={() => onTab(id)} aria-current={tab === id ? "page" : undefined}>
          <Icon size={20} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
