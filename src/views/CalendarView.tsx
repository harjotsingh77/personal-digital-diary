import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, type EntrySummary } from "../lib/api";
import { addMonths, formatMonth, fromISO, monthOf, todayISO, toISO } from "../lib/dates";
import { moodById } from "../lib/moods";

interface Props {
  /** Month to show initially ("YYYY-MM"). */
  initialMonth: string;
  onOpen: (date: string) => void;
}

/** Sunday-first weekday initials in the user's locale. */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: "short" }),
);

export function CalendarView({ initialMonth, onOpen }: Props) {
  const [month, setMonth] = useState(initialMonth);
  const [entries, setEntries] = useState<Map<string, EntrySummary>>(new Map());

  useEffect(() => {
    let live = true;
    api.listEntries(month).then((list) => {
      if (live) setEntries(new Map(list.map((e) => [e.date, e])));
    });
    return () => { live = false; };
  }, [month]);

  // 6 rows × 7 days, starting on the Sunday on/before the 1st.
  const cells = useMemo(() => {
    const first = fromISO(`${month}-01`);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return toISO(d);
    });
  }, [month]);

  const today = todayISO();
  const thisMonth = monthOf(today);

  return (
    <div className="flex h-full flex-col">
      <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center justify-end gap-1 px-6">
        {month !== thisMonth && (
          <button
            onClick={() => setMonth(thisMonth)}
            className="mr-2 animate-fade-in rounded-full border border-line px-3 py-1 text-xs text-muted transition hover:border-accent hover:text-accent"
          >
            This month
          </button>
        )}
        <NavButton label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={17} /></NavButton>
        <NavButton label="Next month" onClick={() => setMonth(addMonths(month, 1))} disabled={month >= thisMonth}><ChevronRight size={17} /></NavButton>
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-10 pb-8 max-sm:px-3 max-sm:pb-3">
        <div className="mb-5 flex items-baseline justify-between">
          <h1 className="font-serif text-[30px] text-ink">{formatMonth(month)}</h1>
          <p className="text-sm text-muted">
            {entries.size} {entries.size === 1 ? "entry" : "entries"}
          </p>
        </div>

        <div className="grid grid-cols-7 pb-2 text-center text-[11px] font-medium uppercase tracking-wider text-muted">
          {WEEKDAYS.map((w) => <div key={w}>{w}</div>)}
        </div>

        <div key={month} className="grid min-h-0 flex-1 animate-fade-in grid-cols-7 grid-rows-6 gap-1.5">
          {cells.map((iso) => {
            const entry = entries.get(iso);
            const inMonth = monthOf(iso) === month;
            const future = iso > today;
            const mood = moodById(entry?.mood);
            return (
              <button
                key={iso}
                disabled={future}
                onClick={() => onOpen(iso)}
                title={entry ? entry.title || entry.preview.slice(0, 60) : undefined}
                className={[
                  "group relative flex flex-col items-start overflow-hidden rounded-xl p-2 text-left transition",
                  entry ? "bg-accent-soft hover:brightness-[0.97]" : "hover:bg-ink/[0.04]",
                  !inMonth && "opacity-35",
                  future && "cursor-default opacity-25 hover:bg-transparent",
                  iso === today && "ring-[1.5px] ring-accent",
                ].filter(Boolean).join(" ")}
              >
                <span className={`text-[13px] tabular-nums ${entry ? "font-semibold text-accent" : "text-ink/70"}`}>
                  {fromISO(iso).getDate()}
                </span>
                {entry && (
                  <span className="mt-auto line-clamp-2 w-full font-serif text-[11.5px] leading-snug text-ink/70">
                    {entry.title || entry.preview}
                  </span>
                )}
                {mood && <span className="absolute right-2 top-1.5 text-[15px]" aria-label={mood.label}>{mood.emoji}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function NavButton(props: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
      className="flex size-8 items-center justify-center rounded-md text-muted transition hover:bg-ink/5 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {props.children}
    </button>
  );
}
