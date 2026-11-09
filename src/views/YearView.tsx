import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, type EntrySummary } from "../lib/api";
import { addDays, fromISO, todayISO, toISO } from "../lib/dates";
import { MOODS, moodById } from "../lib/moods";
import { day as dayNumber, longestRun } from "../lib/streaks";

/** Sequential single-hue steps for the mood score (1–5), against the surface. */
const MOOD_FILL: Record<number, string> = {
  1: "color-mix(in srgb, var(--chart) 18%, var(--surface))",
  2: "color-mix(in srgb, var(--chart) 38%, var(--surface))",
  3: "color-mix(in srgb, var(--chart) 58%, var(--surface))",
  4: "color-mix(in srgb, var(--chart) 78%, var(--surface))",
  5: "var(--chart)",
};
/** A written day with no mood picked: clearly written, but on no mood step. */
const NO_MOOD_RING = "inset 0 0 0 1.5px color-mix(in srgb, var(--muted) 55%, transparent)";

const fullDate = (iso: string) => fromISO(iso).toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric" });

export function YearView({ onOpen }: { onOpen: (date: string) => void }) {
  const thisYear = fromISO(todayISO()).getFullYear();
  const [year, setYear] = useState(thisYear);
  const [all, setAll] = useState<EntrySummary[] | null>(null);

  useEffect(() => {
    api.listEntries().then(setAll).catch(() => setAll([]));
  }, []);

  const entries = useMemo(() => (all ?? []).filter((e) => e.date.startsWith(`${year}-`)), [all, year]);
  const byDate = useMemo(() => new Map(entries.map((e) => [e.date, e])), [entries]);

  const summary = useMemo(() => {
    const tags = new Map<string, number>();
    entries.forEach((e) => e.tags.forEach((t) => tags.set(t, (tags.get(t) ?? 0) + 1)));
    const moods = entries.map((e) => moodById(e.mood)).filter((m) => !!m);
    const longest = [...entries].sort((a, b) => b.wordCount - a.wordCount)[0] ?? null;
    return {
      words: entries.reduce((n, e) => n + e.wordCount, 0),
      notes: entries.reduce((n, e) => n + e.voiceCount + e.videoCount, 0),
      photos: entries.reduce((n, e) => n + e.photoCount, 0),
      bestRun: longestRun(entries.map((e) => dayNumber(e.date))),
      topTags: [...tags].sort((a, b) => b[1] - a[1]).slice(0, 8),
      topMood: MOODS.map((m) => ({ m, n: moods.filter((x) => x.id === m.id).length })).sort((a, b) => b.n - a.n)[0],
      longest,
    };
  }, [entries]);

  const earliest = all?.length ? fromISO(all[all.length - 1].date).getFullYear() : thisYear;

  return (
    <div className="flex h-full flex-col">
      <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center justify-end gap-1 px-6">
        <YearButton label="Previous year" disabled={year <= earliest} onClick={() => setYear(year - 1)}><ChevronLeft size={17} /></YearButton>
        <YearButton label="Next year" disabled={year >= thisYear} onClick={() => setYear(year + 1)}><ChevronRight size={17} /></YearButton>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto max-w-[880px] px-10 pb-20 max-sm:px-4 transition-opacity duration-200 ${all ? "opacity-100" : "opacity-0"}`}>
          <h1 className="font-serif text-[30px] tabular-nums text-ink">{year}</h1>
          <p className="mt-1 text-sm text-muted">
            {entries.length ? `You wrote on ${entries.length} ${entries.length === 1 ? "day" : "days"}.` : "Nothing written this year yet."}
          </p>

          <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 border-y border-line py-5 sm:grid-cols-4">
            <Figure value={summary.words.toLocaleString()} label="words" />
            <Figure value={`${summary.bestRun}`} label={`${summary.bestRun === 1 ? "day" : "days"} in a row, at best`} />
            <Figure value={`${summary.notes}`} label={`voice and video ${summary.notes === 1 ? "note" : "notes"}`} />
            <Figure value={`${summary.photos}`} label={summary.photos === 1 ? "photo" : "photos"} />
          </div>

          <section className="mt-8">
            <h2 className="text-sm font-medium text-ink">Every day of the year</h2>
            <p className="text-xs text-muted">Stronger colour means a better mood. Click a day to open it.</p>
            <Heatmap year={year} byDate={byDate} onOpen={onOpen} />
          </section>

          {(summary.topTags.length > 0 || summary.longest) && (
            <div className="mt-9 grid gap-10 sm:grid-cols-2">
              {summary.topTags.length > 0 && (
                <section>
                  <h2 className="mb-3 text-sm font-medium text-ink">What you wrote about</h2>
                  <ul className="space-y-2">
                    {summary.topTags.map(([tag, n]) => (
                      <li key={tag} className="flex items-center gap-3">
                        <span className="w-24 shrink-0 truncate text-[13px] text-ink/80">#{tag}</span>
                        <div className="flex flex-1 items-center gap-2">
                          <div className="h-3 rounded-r-[4px] bg-chart" style={{ width: `${(n / summary.topTags[0][1]) * 85}%`, minWidth: 4 }} />
                          <span className="text-xs tabular-nums text-muted">{n}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {summary.longest && summary.longest.wordCount > 0 && (
                <section>
                  <h2 className="mb-3 text-sm font-medium text-ink">Your longest page</h2>
                  <button onClick={() => onOpen(summary.longest!.date)} className="text-left">
                    <span className="text-xs text-muted">{fullDate(summary.longest.date)} · {summary.longest.wordCount.toLocaleString()} words</span>
                    <span className="mt-1 line-clamp-3 font-hand text-[16px] leading-relaxed text-ink/80 transition hover:text-ink">{summary.longest.preview}</span>
                  </button>
                </section>
              )}
            </div>
          )}

          <table className="sr-only">
            <caption>Days written in {year}</caption>
            <thead><tr><th>Date</th><th>Mood</th><th>Words</th></tr></thead>
            <tbody>{entries.map((e) => <tr key={e.date}><td>{e.date}</td><td>{moodById(e.mood)?.label ?? "None"}</td><td>{e.wordCount}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="font-serif text-[26px] leading-tight tabular-nums text-ink">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function Heatmap({ year, byDate, onOpen }: { year: number; byDate: Map<string, EntrySummary>; onOpen: (d: string) => void }) {
  const [hover, setHover] = useState<{ date: string; x: number; y: number } | null>(null);
  const today = todayISO();

  const weeks = useMemo(() => {
    const start = new Date(year, 0, 1);
    start.setDate(1 - start.getDay());
    const out: string[][] = [];
    let d = toISO(start);
    while (fromISO(d).getFullYear() <= year) {
      const week = Array.from({ length: 7 }, (_, i) => addDays(d, i));
      out.push(week);
      d = addDays(d, 7);
    }
    return out;
  }, [year]);

  const hovered = hover ? byDate.get(hover.date) : null;

  return (
    <div className="relative mt-3 overflow-x-auto pb-1">
      <div className="grid w-max grid-flow-col gap-[3px]" style={{ gridTemplateRows: "repeat(7, 12px)" }}>
        {weeks.flat().map((date) => {
          if (!date.startsWith(`${year}-`)) return <span key={date} />;
          const entry = byDate.get(date);
          const mood = moodById(entry?.mood);
          const label = `${fullDate(date)}: ${entry ? mood?.label ?? "written, no mood" : "not written"}`;
          return (
            <button
              key={date}
              disabled={date > today}
              onClick={() => onOpen(date)}
              onMouseEnter={(e) => setHover({ date, x: e.currentTarget.offsetLeft, y: e.currentTarget.offsetTop })}
              onMouseLeave={() => setHover(null)}
              aria-label={label}
              className="size-3 rounded-[3px] disabled:opacity-40"
              style={{
                background: mood ? MOOD_FILL[mood.score] : "color-mix(in srgb, var(--ink) 6%, transparent)",
                boxShadow: entry && !mood ? NO_MOOD_RING : undefined,
              }}
            />
          );
        })}
      </div>

      {hover && (
        <div className="pointer-events-none absolute z-10 w-max max-w-[220px] -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg shadow-black/10" style={{ left: Math.max(70, hover.x + 6), top: hover.y - 6 }}>
          <div className="text-muted">{fullDate(hover.date)}</div>
          <div className="mt-0.5 font-medium text-ink">
            {hovered ? `${moodById(hovered.mood)?.label ?? "No mood"} · ${hovered.wordCount} words` : "Not written"}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {MOODS.slice().reverse().map((m) => (
          <span key={m.id} className="flex items-center gap-1.5">
            <span className="size-3 rounded-[3px]" style={{ background: MOOD_FILL[m.score] }} />
            {m.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-[3px]" style={{ boxShadow: NO_MOOD_RING }} />
          Written, no mood
        </span>
      </div>
    </div>
  );
}

function YearButton(props: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button title={props.label} aria-label={props.label} onClick={props.onClick} disabled={props.disabled} className="flex size-8 items-center justify-center rounded-md text-muted transition hover:bg-ink/5 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent">
      {props.children}
    </button>
  );
}
