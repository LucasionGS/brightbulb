import { useState } from "react";
import { ArrowLeft, ChevronRight, Lightbulb, Router, Search } from "lucide-react";
import type { AppSnapshot, BridgeCandidate } from "@shared/ipc";
import "./Onboarding.scss";

export interface OnboardingProps {
  snapshot: AppSnapshot;
  /**
   * Leave onboarding (only offered when a bridge is already paired).
   */
  onClose?: () => void;
}

/**
 * Finding and pairing a bridge, as a full-window flow.
 */
export default function Onboarding(props: OnboardingProps) {
  const { snapshot, onClose } = props;
  const pairing = snapshot.pairing;

  return (
    <div className="bb-onboarding">
      <div className="bb-onboarding__glow" aria-hidden />
      <div className="bb-onboarding__panel">
        {pairing.stage === "idle" && <Welcome />}
        {pairing.stage === "searching" && <Searching />}
        {pairing.stage === "choose" && <Choose candidates={pairing.candidates} />}
        {pairing.stage === "linking" && pairing.selected && <Linking candidate={pairing.selected} secondsLeft={pairing.secondsLeft} total={pairing.totalSeconds} />}
        {pairing.stage === "failed" && <Failed error={pairing.error} candidate={pairing.selected} />}
        {onClose && pairing.stage !== "linking" && (
          <button className="bb-btn bb-btn--ghost bb-onboarding__back" onClick={onClose}>
            <ArrowLeft size={16} /> Back to my lights
          </button>
        )}
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div className="bb-onboarding__stage">
      <div className="bb-onboarding__bulb"><Lightbulb size={44} /></div>
      <h1>Welcome to BrightBulb</h1>
      <p>Control your Philips Hue lights and let them follow what is on your screen. First, let's find your Hue bridge.</p>
      <button className="bb-btn bb-btn--primary bb-onboarding__cta" onClick={() => void window.bb.invoke("discovery:start")}>
        <Search size={16} /> Find my bridge
      </button>
    </div>
  );
}

function Searching() {
  return (
    <div className="bb-onboarding__stage">
      <div className="bb-onboarding__radar" aria-hidden><Router size={34} /></div>
      <h1>Looking for bridges</h1>
      <p>Searching your network for a Philips Hue bridge…</p>
    </div>
  );
}

function Choose(props: { candidates: BridgeCandidate[] }) {
  const { candidates } = props;
  const [host, setHost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  async function connectManual(event: React.FormEvent) {
    event.preventDefault();
    setProbing(true);
    setError(null);
    const result = await window.bb.invoke("discovery:probe", host);
    setProbing(false);
    if (!result.ok) setError(result.message);
    else if (result.value.supportsV2) void window.bb.invoke("pairing:start", result.value);
  }

  return (
    <div className="bb-onboarding__stage bb-onboarding__stage--wide">
      <h1>{candidates.length ? "Choose your bridge" : "No bridges found"}</h1>
      <p>{candidates.length ? "Pick the bridge you want to use." : "Make sure the bridge is powered on and on the same network, or enter its address below."}</p>

      {candidates.length > 0 && (
        <ul className="bb-onboarding__list">
          {candidates.map((c) => (
            <li key={c.bridgeId}>
              <button className="bb-onboarding__bridge" disabled={!c.supportsV2} onClick={() => void window.bb.invoke("pairing:start", c)}>
                <Router size={22} />
                <span className="bb-onboarding__bridge-text">
                  <strong>{c.name}</strong>
                  <span>{c.supportsV2 ? `${c.host} · found via ${c.source}` : `${c.host} · not supported (needs a v2 square bridge)`}</span>
                </span>
                <ChevronRight size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="bb-onboarding__manual" onSubmit={connectManual}>
        <label htmlFor="bridge-host">Enter an address</label>
        <div className="bb-onboarding__manual-row">
          <input
            id="bridge-host"
            className="bb-input"
            placeholder="192.168.1.2"
            value={host}
            onChange={(event) => {
              setHost(event.target.value);
              setError(null);
            }}
            aria-invalid={error !== null}
            aria-describedby={error ? "bridge-host-error" : undefined}
            spellCheck={false}
          />
          <button className="bb-btn bb-btn--primary" type="submit" disabled={!host.trim() || probing}>
            {probing ? "Checking…" : "Connect"}
          </button>
        </div>
        {error && <p id="bridge-host-error" className="bb-onboarding__error" role="alert">{error}</p>}
      </form>

      <button className="bb-btn bb-btn--ghost" onClick={() => void window.bb.invoke("discovery:start")}>
        <Search size={14} /> Search again
      </button>
    </div>
  );
}

function Linking(props: { candidate: BridgeCandidate; secondsLeft: number; total: number }) {
  const { candidate, secondsLeft, total } = props;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="bb-onboarding__stage">
      <div className="bb-onboarding__link">
        <svg viewBox="0 0 120 120" aria-hidden>
          <circle cx="60" cy="60" r={radius} className="bb-onboarding__ring-bg" />
          <circle
            cx="60" cy="60" r={radius}
            className="bb-onboarding__ring"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - secondsLeft / total)}
          />
        </svg>
        <div className="bb-onboarding__device" aria-hidden><span /></div>
      </div>
      <h1>Press the link button</h1>
      <p>Press the round button on top of {candidate.name}. {secondsLeft > 0 && <span className="bb-dim">{secondsLeft} s left</span>}</p>
      <button className="bb-btn" onClick={() => void window.bb.invoke("pairing:cancel")}>Cancel</button>
    </div>
  );
}

function Failed(props: { error: string | null; candidate: BridgeCandidate | null }) {
  const { error, candidate } = props;
  return (
    <div className="bb-onboarding__stage">
      <h1>Could not pair</h1>
      <p className="bb-onboarding__error" role="alert">{error}</p>
      <div className="bb-onboarding__buttons">
        {candidate && <button className="bb-btn bb-btn--primary" onClick={() => void window.bb.invoke("pairing:start", candidate)}>Try again</button>}
        <button className="bb-btn" onClick={() => void window.bb.invoke("discovery:start")}>Search again</button>
      </div>
    </div>
  );
}
