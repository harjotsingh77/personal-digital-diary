import { BookOpen, CalendarDays, CalendarRange, Clock, Flame, Images, Lock, Settings, Smile, type LucideIcon } from "lucide-react";
import type { Stats } from "../lib/api";

export type View = "write" | "calendar" | "timeline" | "photos" | "mood" | "year" | "settings";

export const NAV: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "write", label: "Diary", icon: BookOpen },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "timeline", label: "Timeline and search", icon: Clock },
  { id: "photos", label: "Photos", icon: Images },
  { id: "mood", label: "Mood", icon: Smile },
  { id: "year", label: "Year in review", icon: CalendarRange },
  { id: "settings", label: "Settings", icon: Settings },
];

interface Props {
  view: View;
  onChange: (v: View) => void;
  onLock: () => void;
  stats: Stats | null;
}

/** A slim rail, so the book gets the room. */
export function Sidebar({ view, onChange, onLock, stats }: Props) {
  const railButton = "flex size-10 items-center justify-center rounded-lg transition-colors active:scale-95";
  return (
    <aside className="flex w-[76px] shrink-0 flex-col items-center bg-sidebar">
      {/* Space for the macOS traffic lights; doubles as a drag handle. */}
      <div data-tauri-drag-region className="h-[52px] w-full shrink-0" />

      <nav className="flex flex-1 flex-col items-center gap-1">
        {NAV.map(({ id, label, icon: Icon }, i) => {
          const active = id === view;
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              title={`${label} (⌘${i + 1})`}
              aria-label={label}
              aria-current={active ? "page" : undefined}
              className={`${railButton} ${active ? "bg-accent-soft text-accent" : "text-muted hover:bg-ink/5 hover:text-ink"}`}
            >
              <Icon size={18} strokeWidth={1.75} />
            </button>
          );
        })}
      </nav>

      <div className="flex flex-col items-center gap-2 pb-3">
        {stats && stats.currentStreak > 0 && (
          <div
            className="flex animate-fade-in items-center gap-1 text-[12px] tabular-nums text-muted"
            title={`${stats.currentStreak}-day streak · longest ${stats.longestStreak} · ${stats.totalEntries} ${stats.totalEntries === 1 ? "page" : "pages"} written`}
          >
            <Flame size={13} className={stats.writtenToday ? "text-accent" : ""} />
            {stats.currentStreak}
          </div>
        )}
        <button onClick={onLock} title="Lock diary (⌘L)" aria-label="Lock diary" className={`${railButton} text-muted hover:bg-ink/5 hover:text-ink`}>
          <Lock size={17} strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  );
}
