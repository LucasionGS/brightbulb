import { Clapperboard, MonitorPlay } from "lucide-react";
import type { AppSnapshot, SyncOptions } from "@shared/ipc";
import { LIMITS } from "@shared/settingsCodec";
import EmptyState from "../../components/EmptyState/EmptyState";
import MonitorPicker from "../../components/MonitorPicker/MonitorPicker";
import Select from "../../components/Select/Select";
import Slider from "../../components/Slider/Slider";
import Switch from "../../components/Switch/Switch";
import SyncHero from "../../components/SyncHero/SyncHero";
import SyncPreview from "../../components/SyncPreview/SyncPreview";
import { toast } from "../../components/Toasts/Toasts";
import { useLiveValue } from "../../lib/useLiveValue";
import "./Sync.scss";

export interface SyncProps {
  snapshot: AppSnapshot;
}

const FPS_OPTIONS = [30, 45, 60];

export default function Sync(props: SyncProps) {
  const { snapshot } = props;
  const { sync, areas, capture } = snapshot;
  const options = sync.options;
  const area = areas.find((a) => a.id === sync.areaId) ?? null;
  const active = sync.phase === "starting" || sync.phase === "streaming";

  const [brightness, setBrightness] = useLiveValue(options.brightness);
  const [saturation, setSaturation] = useLiveValue(options.saturation);
  const [smoothing, setSmoothing] = useLiveValue(options.smoothing);

  function set(patch: Partial<SyncOptions>) {
    void window.bb.invoke("sync:setOptions", patch).then((result) => {
      if (!result.ok) toast("Could not change that setting", { description: result.message, type: "error" });
    });
  }

  async function toggle() {
    const result = await window.bb.invoke(active ? "sync:stop" : "sync:start");
    if (!result.ok) toast(active ? "Could not stop mirroring" : "Could not start mirroring", { description: result.message, type: "error" });
  }

  if (snapshot.connection.state === "connected" && areas.length === 0) {
    return (
      <div className="bb-page">
        <EmptyState
          icon={Clapperboard}
          title="No entertainment areas"
          description="Screen mirroring streams to an entertainment area. Create one in the Hue app under Settings → Entertainment areas, then come back."
        />
      </div>
    );
  }

  const backendOptions = [
    { value: "auto", label: `Automatic${capture.detected ? ` (${capture.backends.find((b) => b.id === capture.detected)?.name ?? capture.detected})` : ""}` },
    ...capture.backends.map((b) => ({ value: b.id, label: b.name, hint: b.available ? undefined : b.reason ?? "Unavailable", disabled: !b.available })),
  ];

  return (
    <div className="bb-page">
      <SyncHero sync={sync} canStart={snapshot.connection.state === "connected" && area !== null} onToggle={toggle} />

      {active && area && (
        <section className="bb-card bb-sync__section">
          <h2 className="bb-section-title">Live preview</h2>
          <SyncPreview area={area} screenAtPositiveY={options.screenAtPositiveY} />
        </section>
      )}

      <div className="bb-sync__columns">
        <section className="bb-card bb-sync__section">
          <h2 className="bb-section-title">Where</h2>
          <label className="bb-sync__field">
            <span>Entertainment area</span>
            <Select
              label="Entertainment area"
              value={sync.areaId}
              options={areas.map((a) => ({
                value: a.id,
                label: `${a.name} · ${a.channels.length} light${a.channels.length === 1 ? "" : "s"}`,
                hint: a.type.toLowerCase() === "screen" ? "Set up for screens" : undefined,
              }))}
              onChange={(id) => void window.bb.invoke("sync:setArea", id)}
            />
          </label>
          <div className="bb-sync__row">
            <div>
              <div>Screen is at the far end</div>
              <div className="bb-dim bb-sync__hint">If your lights mirror the wrong way round, switch this.</div>
            </div>
            <Switch checked={options.screenAtPositiveY} onChange={(screenAtPositiveY) => set({ screenAtPositiveY })} label="Screen is at the far end" />
          </div>
        </section>

        <section className="bb-card bb-sync__section">
          <h2 className="bb-section-title">Look</h2>
          <Slider
            label="Brightness"
            value={brightness}
            min={LIMITS.BRIGHTNESS.MIN}
            max={LIMITS.BRIGHTNESS.MAX}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => {
              setBrightness(v);
              set({ brightness: v });
            }}
          />
          <Slider
            label="Saturation"
            value={saturation}
            min={LIMITS.SATURATION.MIN}
            max={LIMITS.SATURATION.MAX}
            step={0.01}
            format={(v) => `${v.toFixed(2)}×`}
            track="linear-gradient(90deg, #8a8f99, #ff5f6d, #ffc371, #7cf29c, #4fc3f7, #b388ff)"
            onChange={(v) => {
              setSaturation(v);
              set({ saturation: v });
            }}
          />
          <Slider
            label="Smoothing"
            value={smoothing}
            min={0}
            max={0.95}
            step={0.01}
            format={(v) => (v < 0.25 ? "Snappy" : v < 0.6 ? "Balanced" : "Calm")}
            onChange={(v) => {
              setSmoothing(v);
              set({ smoothing: v });
            }}
          />
        </section>
      </div>

      <section className="bb-card bb-sync__section">
        <h2 className="bb-section-title"><MonitorPlay size={14} /> Screen</h2>
        <MonitorPicker
          selected={options.monitor}
          onSelect={(monitor) => set({ monitor })}
          reloadKey={`${options.backend}:${capture.detected}`}
        />
      </section>

      <details className="bb-card bb-sync__advanced">
        <summary>Advanced</summary>
        <div className="bb-sync__columns">
          <label className="bb-sync__field">
            <span>Capture method</span>
            <Select label="Capture method" value={options.backend} options={backendOptions} onChange={(backend) => set({ backend: backend as SyncOptions["backend"] })} />
          </label>
          <label className="bb-sync__field">
            <span>Frame rate</span>
            <Select
              label="Frame rate"
              value={String(options.fps)}
              options={FPS_OPTIONS.map((fps) => ({ value: String(fps), label: `${fps} fps`, hint: fps === 60 ? "Smoothest" : undefined }))}
              onChange={(fps) => set({ fps: parseInt(fps) })}
            />
          </label>
        </div>
      </details>
    </div>
  );
}
