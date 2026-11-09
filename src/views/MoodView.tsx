import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, type EntrySummary } from "../lib/api";
import { addMonths, formatMonth, fromISO, monthOf, todayISO } from "../lib/dates";
import { MOODS, moodById } from "../lib/moods";

interface Props {
  onOpen: (date: string) => void;
}

interface Point {
  day: number;
  date: string;
  score: number;
  entry: EntrySummary;
}

export function MoodView({ onOpen }: Props) {
  const thisMonth = monthOf(todayISO());
  const [month, setMonth] = useState(thisMonth);
  /** null while loading, so the empty state doesn't flash. */
  const [entries, setEntries] = useState<EntrySummary[] | null>(null);

  useEffect(() => {
    let live = true;
    setEntries(null);
    api.listEntries(month).then((l) => live && setEntries(l));
    return () => { live = false; };
  }, [month]);

  const points: Point[] = useMemo(
    () =>
      (entries ?? [])
        .filter((e) => moodById(e.mood))
        .map((e) => ({ day: fromISO(e.date).getDate(), date: e.date, score: moodById(e.mood)!.score, entry: e }))
        .sort((a, b) => a.day - b.day),
    [entries],
  );

  const counts = MOODS.map((m) => ({ mood: m, count: points.filter((p) => p.score === m.score).length }));
  const avg = points.length ? points.reduce((s, p) => s + p.score, 0) / points.length : null;
  const avgMood = avg ? MOODS.reduce((best, m) => (Math.abs(m.score - avg) < Math.abs(best.score - avg) ? m : best)) : null;
  const daysInMonth = new Date(fromISO(`${month}-01`).getFullYear(), fromISO(`${month}-01`).getMonth() + 1, 0).getDate();

  return (
    <div className="flex h-full flex-col">
      <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center justify-end gap-1 px-6">
        <NavButton label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={17} /></NavButton>
        <NavButton label="Next month" onClick={() => setMonth(addMonths(month, 1))} disabled={month >= thisMonth}><ChevronRight size={17} /></NavButton>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] px-10 pb-20 max-sm:px-4">
          <h1 className="font-serif text-[30px] text-ink">Mood</h1>
          <p className="mt-1 text-sm text-muted">{formatMonth(month)}</p>

          <div key={month} className={`transition-opacity duration-200 ${entries ? "opacity-100" : "opacity-0"}`}>
            <div className="mt-6 grid grid-cols-3 gap-3">
              <Tile label="Average mood" value={avgMood ? `${avgMood.emoji} ${avgMood.label}` : "—"} sub={avg ? `${avg.toFixed(1)} / 5` : "No moods yet"} />
              <Tile label="Days logged" value={String(points.length)} sub={`of ${daysInMonth} days`} />
              <Tile
                label="Most frequent"
                value={points.length ? (() => { const top = [...counts].sort((a, b) => b.count - a.count)[0]; return `${top.mood.emoji} ${top.mood.label}`; })() : "—"}
                sub={points.length ? `${[...counts].sort((a, b) => b.count - a.count)[0].count} days` : " "}
              />
            </div>

            <section className="mt-6 rounded-2xl border border-line bg-surface p-5">
              <h2 className="text-sm font-medium text-ink">Daily mood</h2>
              <p className="text-xs text-muted">Click a point to open that day</p>
              <MoodChart points={points} daysInMonth={daysInMonth} month={month} onOpen={onOpen} />
            </section>

            <section className="mt-4 rounded-2xl border border-line bg-surface p-5">
              <h2 className="mb-3 text-sm font-medium text-ink">How the month felt</h2>
              <Distribution counts={counts} />
            </section>

            {/* Screen-reader / data view */}
            <table className="sr-only">
              <caption>Mood by day, {formatMonth(month)}</caption>
              <thead><tr><th>Date</th><th>Mood</th></tr></thead>
              <tbody>{points.map((p) => <tr key={p.date}><td>{p.date}</td><td>{moodById(p.entry.mood)?.label}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-4 py-3.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 font-serif text-xl text-ink">{value}</div>
      <div className="text-xs text-muted">{sub}</div>
    </div>
  );
}

const H = 220;
const PAD = { top: 14, right: 12, bottom: 26, left: 34 };

/** Mood score (1–5) per day: 2px line joining consecutive days, ringed dots, hover tooltip. */
function MoodChart({ points, daysInMonth, month, onOpen }: { points: Point[]; daysInMonth: number; month: string; onOpen: (d: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<Point | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (day: number) => PAD.left + ((day - 1) / Math.max(daysInMonth - 1, 1)) * plotW;
  const y = (score: number) => PAD.top + ((5 - score) / 4) * plotH;

  // Only connect days that are back-to-back; a gap means no entry.
  const segments: Point[][] = [];
  for (const p of points) {
    const last = segments[segments.length - 1];
    if (last && last[last.length - 1].day === p.day - 1) last.push(p);
    else segments.push([p]);
  }

  const ticks = [1, 8, 15, 22, 29].filter((d) => d <= daysInMonth);
  const monthShort = fromISO(`${month}-01`).toLocaleDateString(undefined, { month: "short" });

  return (
    <div ref={wrap} className="relative mt-3">
      <svg width={width} height={H} className="block overflow-visible" role="img" aria-label="Daily mood chart">
        {MOODS.map((m) => (
          <g key={m.id}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(m.score)} y2={y(m.score)} stroke="var(--line)" strokeWidth={1} />
            <text x={PAD.left - 10} y={y(m.score)} dy="0.35em" textAnchor="end" fontSize={14}>{m.emoji}</text>
          </g>
        ))}
        {ticks.map((d) => (
          <text key={d} x={x(d)} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {d === 1 ? `${monthShort} 1` : d}
          </text>
        ))}
        {segments.filter((s) => s.length > 1).map((s, i) => (
          <polyline
            key={i}
            points={s.map((p) => `${x(p.day)},${y(p.score)}`).join(" ")}
            fill="none"
            stroke="var(--chart)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {hover && <line x1={x(hover.day)} x2={x(hover.day)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--muted)" strokeOpacity={0.35} strokeWidth={1} />}
        {points.map((p) => (
          <circle
            key={p.date}
            cx={x(p.day)}
            cy={y(p.score)}
            r={hover?.date === p.date ? 6 : 4.5}
            fill="var(--chart)"
            stroke="var(--surface)"
            strokeWidth={2}
            className="transition-all duration-150"
          />
        ))}
        {/* Generous invisible hit areas, one column per logged day. */}
        {points.map((p) => (
          <rect
            key={`hit${p.date}`}
            x={x(p.day) - Math.max(plotW / daysInMonth / 2, 8)}
            y={PAD.top - 8}
            width={Math.max(plotW / daysInMonth, 16)}
            height={plotH + 16}
            fill="transparent"
            className="cursor-pointer"
            onMouseEnter={() => setHover(p)}
            onMouseLeave={() => setHover(null)}
            onClick={() => onOpen(p.date)}
          />
        ))}
      </svg>

      {points.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted">
          Pick a mood when you write, and it'll show up here.
        </div>
      )}

      {hover && (
        <div
          className="pointer-events-none absolute z-10 w-max max-w-[220px] -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg shadow-black/10"
          style={{ left: x(hover.day), top: y(hover.score) - 12 }}
        >
          <div className="text-muted">{fromISO(hover.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
          <div className="mt-0.5 font-medium text-ink">{moodById(hover.entry.mood)?.emoji} {moodById(hover.entry.mood)?.label}</div>
          {hover.entry.title && <div className="mt-0.5 truncate font-serif text-ink/70">{hover.entry.title}</div>}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars: days per mood, value at the bar tip. */
function Distribution({ counts }: { counts: { mood: (typeof MOODS)[number]; count: number }[] }) {
  const max = Math.max(1, ...counts.map((c) => c.count));
  return (
    <ul className="space-y-2.5">
      {counts.map(({ mood, count }) => (
        <li key={mood.id} className="flex items-center gap-3" title={`${mood.label}: ${count} ${count === 1 ? "day" : "days"}`}>
          <span className="w-20 shrink-0 text-[13px] text-ink/80">{mood.emoji} {mood.label}</span>
          <div className="flex flex-1 items-center gap-2">
            <div
              className="h-3.5 rounded-r-[4px] bg-chart transition-[width] duration-500 ease-out"
              style={{ width: `${(count / max) * 85}%`, minWidth: count ? 4 : 0 }}
            />
            <span className="text-xs tabular-nums text-muted">{count}</span>
          </div>
        </li>
      ))}
    </ul>
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
