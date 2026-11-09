import { useCallback, useEffect, useState } from "react";
import { api, type AuthStatus, type Stats } from "./lib/api";
import { clearPhotoCache } from "./lib/photos";
import { clearVoiceCache } from "./lib/voice";
import { MoodView } from "./views/MoodView";
import { useAutoLock } from "./hooks/useAutoLock";
import { LockScreen } from "./components/LockScreen";
import { NAV, Sidebar, type View } from "./components/Sidebar";
import { GalleryView } from "./views/GalleryView";
import { YearView } from "./views/YearView";
import { SettingsView } from "./views/SettingsView";
import { WriteView } from "./views/WriteView";
import { flushAll } from "./lib/saveRegistry";
import { addDays, monthOf, todayISO } from "./lib/dates";
import { CalendarView } from "./views/CalendarView";
import { TimelineView } from "./views/TimelineView";

/** Lock automatically after this much inactivity. */
const AUTO_LOCK_MS = 5 * 60 * 1000;
/** How often to see whether an automatic backup has come due. */
const AUTO_BACKUP_CHECK_MS = 60 * 60 * 1000;

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [view, setView] = useState<View>("write");
  /** The day shown in the Write view; Calendar/Timeline set it to open a day. */
  const [date, setDate] = useState(todayISO);
  const [stats, setStats] = useState<Stats | null>(null);
  /** Incremented by ⌘F so the Timeline focuses its search box. */
  const [searchSignal, setSearchSignal] = useState(0);
  const [hasRecovery, setHasRecovery] = useState(false);

  const refreshStats = useCallback(() => {
    api.getStats(todayISO()).then(setStats).catch(() => {});
  }, []);

  /** Open a day in the editor (from Calendar / Timeline / search). */
  const openDate = useCallback((d: string) => {
    setDate(d);
    setView("write");
  }, []);

  const refresh = useCallback(() => api.authStatus().then(setStatus), []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (status && !status.unlocked) api.hasRecoveryKey().then(setHasRecovery).catch(() => {});
  }, [status]);

  const lock = useCallback(async () => {
    await flushAll(); // save unsaved writing before the key is forgotten
    await api.lock();
    clearPhotoCache();
    clearVoiceCache();
    setStats(null);
    await refresh();
  }, [refresh]);

  useAutoLock(!!status?.unlocked, AUTO_LOCK_MS, lock);

  useEffect(() => {
    if (!status?.unlocked) return;
    refreshStats();
    // Unlocking opens on today's page, even if the diary was locked yesterday.
    setDate(todayISO());
  }, [status?.unlocked, refreshStats]);

  useEffect(() => {
    if (!status?.unlocked) return;
    const check = () => { api.runAutoBackup(todayISO(), false).catch(() => {}); };
    check();
    const id = window.setInterval(check, AUTO_BACKUP_CHECK_MS);
    return () => window.clearInterval(id);
  }, [status?.unlocked]);

  // ⌘L locks immediately; ⌘F searches; ⌘1–7 switch views; ⌘[ and ⌘] turn pages.
  useEffect(() => {
    if (!status?.unlocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === "l") { e.preventDefault(); lock(); }
      else if (k === "f") { e.preventDefault(); setView("timeline"); setSearchSignal((n) => n + 1); }
      else if (k === "n") { e.preventDefault(); openDate(todayISO()); }
      else if (/^[1-7]$/.test(k) && !e.altKey) { e.preventDefault(); setView(NAV[Number(k) - 1].id); }
      else if (k === "[") { e.preventDefault(); setDate((d) => addDays(d, -1)); setView("write"); }
      else if (k === "]") { e.preventDefault(); setDate((d) => (d < todayISO() ? addDays(d, 1) : d)); setView("write"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status?.unlocked, lock, openDate]);

  if (!status) return <div className="h-full bg-paper" />;

  if (!status.unlocked) {
    return <LockScreen mode={status.hasPassword ? "unlock" : "setup"} touchId={status.touchId} hasRecovery={hasRecovery} onUnlocked={refresh} />;
  }

  return (
    <div className="flex h-full animate-fade-in max-sm:flex-col-reverse">
      <Sidebar view={view} onChange={setView} onLock={lock} stats={stats} />
      <main className="relative min-h-0 flex-1 overflow-hidden bg-paper max-sm:pt-[env(safe-area-inset-top)]">
        <div key={view} className="h-full animate-rise">
          {view === "write" && <WriteView date={date} onDateChange={setDate} onSaved={refreshStats} />}
          {view === "calendar" && <CalendarView initialMonth={monthOf(date)} onOpen={openDate} />}
          {view === "timeline" && <TimelineView onOpen={openDate} focusSearch={searchSignal} />}
          {view === "photos" && <GalleryView onOpen={openDate} />}
          {view === "mood" && <MoodView onOpen={openDate} />}
          {view === "year" && <YearView onOpen={openDate} />}
          {view === "settings" && <SettingsView onDataChanged={refreshStats} />}
        </div>
      </main>
    </div>
  );
}
