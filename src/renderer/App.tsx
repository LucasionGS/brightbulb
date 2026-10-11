import { useCallback, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import ConnectionBanner from "./components/ConnectionBanner/ConnectionBanner";
import TitleBar, { BottomNav, TABS, type Tab } from "./components/TitleBar/TitleBar";
import Toasts, { toast } from "./components/Toasts/Toasts";
import { useSnapshot } from "./lib/store";
import Lights from "./pages/Lights/Lights";
import Onboarding from "./pages/Onboarding/Onboarding";
import Scenes from "./pages/Scenes/Scenes";
import Settings from "./pages/Settings/Settings";
import Sync from "./pages/Sync/Sync";
import "./App.scss";

const TAB_KEY = "bb.tab";

export default function App() {
  const snapshot = useSnapshot();
  const [tab, setTab] = useTab();
  useShortcuts(setTab);

  if (!snapshot) {
    return (
      <div className="bb-app bb-app--loading">
        <LoaderCircle size={28} className="bb-spin" />
      </div>
    );
  }

  const paired = snapshot.connection.bridge !== null;
  const onboarding = !paired || snapshot.pairing.stage !== "idle";
  const mirroring = snapshot.sync.phase === "streaming" || snapshot.sync.phase === "starting";

  return (
    <div className="bb-app">
      <TitleBar tab={tab} onTab={setTab} connection={snapshot.connection} showTabs={!onboarding} mirroring={mirroring} />
      <main className="bb-app__content">
        {onboarding ? (
          <Onboarding snapshot={snapshot} onClose={paired ? () => void window.bb.invoke("pairing:cancel") : undefined} />
        ) : (
          <>
            {tab !== "settings" && <ConnectionBanner connection={snapshot.connection} onOpenSettings={() => setTab("settings")} />}
            {tab === "lights" && <Lights snapshot={snapshot} />}
            {tab === "scenes" && <Scenes snapshot={snapshot} />}
            {tab === "sync" && <Sync snapshot={snapshot} />}
            {tab === "settings" && <Settings snapshot={snapshot} />}
          </>
        )}
      </main>
      {!onboarding && <BottomNav tab={tab} onTab={setTab} />}
      <Toasts />
    </div>
  );
}

function useTab(): [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem(TAB_KEY);
    return TABS.some((t) => t.id === saved) ? saved as Tab : "lights";
  });
  const select = useCallback((next: Tab) => {
    localStorage.setItem(TAB_KEY, next);
    setTab(next);
  }, []);
  return [tab, select];
}

/**
 * Ctrl+1…4 switch pages, Ctrl+H hides to the tray and Ctrl+Q quits.
 */
function useShortcuts(setTab: (tab: Tab) => void) {
  useEffect(() => {
    const onKey = async (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const index = parseInt(event.key) - 1;
      if (index >= 0 && index < TABS.length) {
        event.preventDefault();
        setTab(TABS[index].id);
      }
      else if (event.key === "q") {
        event.preventDefault();
        await window.bb.invoke("app:quit");
      }
      else if (event.key === "h") {
        event.preventDefault();
        const result = await window.bb.invoke("window:hideToTray");
        if (!result.ok) toast(result.message);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTab]);
}
