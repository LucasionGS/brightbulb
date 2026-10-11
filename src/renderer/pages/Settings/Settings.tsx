import { useState } from "react";
import { Copy, ExternalLink, KeyRound, Router, ShieldAlert, ShieldCheck } from "lucide-react";
import type { AppSnapshot, Result } from "@shared/ipc";
import ConfirmDialog from "../../components/ConfirmDialog/ConfirmDialog";
import Switch from "../../components/Switch/Switch";
import { toast } from "../../components/Toasts/Toasts";
import "./Settings.scss";

export interface SettingsProps {
  snapshot: AppSnapshot;
}

const STATE_LABELS: Record<string, [string, string]> = {
  connected: ["Connected", "success"],
  connecting: ["Connecting", "warning"],
  error: ["Unreachable", "danger"],
  unauthorized: ["Access revoked", "danger"],
  disconnected: ["Not connected", "neutral"],
};

function report(result: Result, failed: string, done?: string) {
  if (!result.ok) toast(failed, { description: result.message, type: "error" });
  else if (done) toast(done, { type: "success" });
}

export default function Settings(props: SettingsProps) {
  const { snapshot } = props;
  const { connection, capture, secrets } = snapshot;
  const [confirmForget, setConfirmForget] = useState(false);
  const [label, tone] = STATE_LABELS[connection.state];

  return (
    <div className="bb-page">
      <header className="bb-page-header">
        <div>
          <h1>Settings</h1>
        </div>
      </header>

      <section className="bb-card bb-settings__section">
        <h2 className="bb-section-title">Bridge</h2>
        {connection.bridge ? (
          <div className="bb-settings__bridge">
            <div className="bb-settings__bridge-icon"><Router size={24} /></div>
            <div className="bb-settings__bridge-text">
              <div className="bb-settings__bridge-name">
                {connection.bridge.name} <span className={`bb-badge bb-badge--${tone}`}>{label}</span>
              </div>
              <div className="bb-muted bb-mono">{connection.bridge.host} · {connection.bridge.id}</div>
              {connection.detail && connection.state !== "connected" && <p className="bb-settings__detail">{connection.detail}</p>}
            </div>
          </div>
        ) : (
          <p className="bb-muted">No bridge is paired.</p>
        )}
        <div className="bb-settings__actions">
          {connection.code === "cert-changed" && (
            <button className="bb-btn bb-btn--primary" onClick={async () => report(await window.bb.invoke("bridge:retrustCert"), "Could not trust the new certificate")}>
              Trust new certificate
            </button>
          )}
          {connection.bridge && (
            <button className="bb-btn" onClick={async () => report(await window.bb.invoke("bridge:reconnect"), "Could not reconnect")}>Reconnect</button>
          )}
          <button className="bb-btn" onClick={() => void window.bb.invoke("discovery:start")}>
            {connection.bridge ? "Pair a different bridge" : "Find my bridge"}
          </button>
          {connection.bridge && (
            <button className="bb-btn bb-btn--danger" onClick={() => setConfirmForget(true)}>Forget bridge</button>
          )}
        </div>
      </section>

      <section className="bb-card bb-settings__section">
        <h2 className="bb-section-title">App</h2>
        <div className="bb-settings__row">
          <div>
            <div>Close to tray</div>
            <div className="bb-dim bb-settings__hint">
              {snapshot.tray.available
                ? "Closing the window keeps BrightBulb, and mirroring, running in the tray."
                : "No system tray is running, so closing the window quits."}
            </div>
          </div>
          <Switch
            checked={snapshot.settings.closeToTray}
            onChange={(closeToTray) => void window.bb.invoke("settings:set", { closeToTray })}
            label="Close to tray"
          />
        </div>
      </section>

      <section className="bb-card bb-settings__section">
        <h2 className="bb-section-title">Screen capture</h2>
        <p className="bb-muted">BrightBulb captures your screen with the first method that works here, without asking you to pick a screen. You can force one under Sync → Advanced.</p>
        <ul className="bb-settings__backends">
          {capture.backends.map((backend) => (
            <li key={backend.id}>
              <div className="bb-settings__backend-head">
                <span>{backend.name}</span>
                {capture.detected === backend.id && <span className="bb-badge bb-badge--success">In use</span>}
                {!backend.available && <span className="bb-badge">Unavailable</span>}
              </div>
              {backend.reason && <div className="bb-dim bb-settings__hint">{backend.reason}</div>}
              {backend.installHint && <CommandHint command={backend.installHint} />}
            </li>
          ))}
        </ul>
      </section>

      <section className="bb-card bb-settings__section">
        <h2 className="bb-section-title">Security</h2>
        <div className="bb-settings__security">
          {secrets.locked ? <ShieldAlert size={20} className="bb-settings__warn" /> : secrets.insecure ? <KeyRound size={20} className="bb-settings__warn" /> : <ShieldCheck size={20} className="bb-settings__ok" />}
          <p className="bb-muted">
            {secrets.locked
              ? "The keyring is locked or unavailable, so the bridge keys cannot be read. Unlock it, then reconnect."
              : secrets.insecure
                ? `Bridge keys are stored without a keyring (${secrets.backend}). Install and run a Secret Service such as gnome-keyring or KWallet to encrypt them.`
                : `Bridge keys are encrypted with your keyring (${secrets.backend}).`}
          </p>
        </div>
      </section>

      <section className="bb-card bb-settings__section">
        <h2 className="bb-section-title">About</h2>
        <p className="bb-muted">BrightBulb {snapshot.version}: an open source Philips Hue control centre with screen mirroring. Licensed under the GPL-3.0.</p>
        <div>
          <a className="bb-btn" href="https://github.com/LucasionGS/brightbulb" target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Source code
          </a>
        </div>
      </section>

      <ConfirmDialog
        open={confirmForget}
        title="Forget this bridge?"
        description="BrightBulb will delete its keys for this bridge. To use it again you will have to press the link button."
        confirmLabel="Forget bridge"
        onCancel={() => setConfirmForget(false)}
        onConfirm={async () => {
          setConfirmForget(false);
          report(await window.bb.invoke("bridge:forget"), "Could not forget the bridge", "Bridge forgotten");
        }}
      />
    </div>
  );
}

function CommandHint(props: { command: string }) {
  const { command } = props;
  return (
    <div className="bb-settings__command">
      <code className="bb-mono">{command}</code>
      <button
        className="bb-btn bb-btn--ghost bb-btn--icon bb-btn--sm"
        aria-label="Copy command"
        onClick={() => void navigator.clipboard.writeText(command).then(() => toast("Copied to clipboard"))}
      >
        <Copy size={14} />
      </button>
    </div>
  );
}
