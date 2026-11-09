import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Feather, ImageIcon, Mic, Search, Video, X } from "lucide-react";
import { api, type EntrySummary, type SearchFilters, type TagCount } from "../lib/api";
import { formatMonth, fromISO, monthOf, relativeLabel } from "../lib/dates";
import { MOODS, moodById } from "../lib/moods";
import { usePhotoUrl } from "../hooks/usePhotoUrl";

interface Props {
  onOpen: (date: string) => void;
  /** Bumped by ⌘F to focus the search box. */
  focusSearch?: number;
}

export function TimelineView({ onOpen, focusSearch }: Props) {
  const [all, setAll] = useState<EntrySummary[] | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntrySummary[] | null>(null);
  const [mood, setMood] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [favourite, setFavourite] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.listEntries().then(setAll);
    api.listTags().then(setTags).catch(() => {});
  }, []);

  useEffect(() => {
    if (focusSearch) searchRef.current?.focus();
  }, [focusSearch]);

  const hasFilters = !!mood || !!from || !!to || favourite;

  // Debounced full-text search (runs in Rust over decrypted entries).
  useEffect(() => {
    if (!query.trim() && !hasFilters) return setResults(null);
    let live = true;
    const filters: SearchFilters = { mood, from: from || null, to: to || null, favourite };
    const t = window.setTimeout(() => {
      api.searchEntries(query, filters).then((r) => live && setResults(r));
    }, 200);
    return () => { live = false; window.clearTimeout(t); };
  }, [query, hasFilters, mood, from, to, favourite]);

  const searching = query.trim().length > 0 || hasFilters;
  const clearFilters = () => { setMood(null); setFrom(""); setTo(""); setFavourite(false); };
  const shown = searching ? results : all;
  const activeTags = new Set(query.split(/\s+/).filter((w) => w.startsWith("#")).map((w) => w.slice(1).toLowerCase()));
  const firstWord = query.split(/\s+/).find((w) => w && !w.startsWith("#")) ?? "";

  const toggleTag = (tag: string) => {
    const words = query.split(/\s+/).filter(Boolean);
    const next = activeTags.has(tag) ? words.filter((w) => w.toLowerCase() !== `#${tag}`) : [...words, `#${tag}`];
    setQuery(next.join(" ") + (next.length ? " " : ""));
  };

  // Group consecutive entries under a month heading.
  const groups = useMemo(() => {
    const out: { month: string; items: EntrySummary[] }[] = [];
    for (const e of shown ?? []) {
      const m = monthOf(e.date);
      if (out[out.length - 1]?.month !== m) out.push({ month: m, items: [] });
      out[out.length - 1].items.push(e);
    }
    return out;
  }, [shown]);

  return (
    <div className="flex h-full flex-col">
      <header data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-10 pb-24 max-sm:px-4">
          <div className="flex items-baseline justify-between">
            <h1 className="font-serif text-[30px] text-ink">Timeline</h1>
            <p className="text-sm text-muted">
              {shown ? `${shown.length} ${searching ? (shown.length === 1 ? "result" : "results") : shown.length === 1 ? "entry" : "entries"}` : " "}
            </p>
          </div>

          <label className="mt-5 flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-2.5 transition focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10">
            <Search size={16} className="text-muted" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Search your diary…  (try #tag)"
              className="flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-muted/70"
              aria-label="Search entries"
            />
            {query && (
              <button onClick={() => setQuery("")} aria-label="Clear search" className="text-muted hover:text-ink">
                <X size={15} />
              </button>
            )}
            <kbd className="text-[11px] text-muted/70">⌘F</kbd>
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
            <button
              onClick={() => setFavourite(!favourite)}
              aria-pressed={favourite}
              className={`flex items-center gap-1 transition hover:text-ink ${favourite ? "font-medium text-accent" : ""}`}
            >
              <Bookmark size={13} fill={favourite ? "currentColor" : "none"} /> Bookmarked
            </button>
            <div className="flex items-center gap-0.5" role="group" aria-label="Filter by mood">
              {MOODS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMood(mood === m.id ? null : m.id)}
                  aria-pressed={mood === m.id}
                  title={m.label}
                  aria-label={m.label}
                  className={`flex size-7 items-center justify-center rounded-md text-[15px] transition ${mood === m.id ? "bg-accent-soft" : "opacity-60 hover:opacity-100"}`}
                >
                  {m.emoji}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5">
              From
              <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-ink outline-none focus:border-accent" />
            </label>
            <label className="flex items-center gap-1.5">
              to
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-ink outline-none focus:border-accent" />
            </label>
            {hasFilters && <button onClick={clearFilters} className="underline underline-offset-4 transition hover:text-ink">Clear</button>}
          </div>

          {tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {tags.slice(0, 12).map((t) => (
                <button
                  key={t.tag}
                  onClick={() => toggleTag(t.tag)}
                  className={`rounded-full px-2.5 py-1 text-xs transition ${
                    activeTags.has(t.tag) ? "bg-accent text-white" : "bg-accent-soft text-accent hover:brightness-95"
                  }`}
                >
                  #{t.tag} <span className="opacity-60">{t.count}</span>
                </button>
              ))}
            </div>
          )}

          {all?.length === 0 && <EmptyState title="Nothing here yet" body="Your entries will appear here, newest first." />}
          {searching && results?.length === 0 && <EmptyState title="No matches" body="Try different words, or fewer of them." />}

          {groups.map((g) => (
            <section key={g.month} className="mt-8">
              <h2 className="sticky top-0 z-10 -mx-2 bg-paper/90 px-2 py-2 text-xs font-medium uppercase tracking-[0.14em] text-muted backdrop-blur">
                {formatMonth(g.month)}
              </h2>
              <ul className="mt-2 space-y-2">
                {g.items.map((e, i) => (
                  <li key={e.date} className="animate-rise" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                    <EntryCard entry={e} onOpen={onOpen} highlight={searching ? firstWord : undefined} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export function EntryCard({ entry: e, onOpen, highlight }: { entry: EntrySummary; onOpen: (d: string) => void; highlight?: string }) {
  const d = fromISO(e.date);
  const mood = moodById(e.mood);
  const cover = usePhotoUrl(e.coverPhoto);
  return (
    <button
      onClick={() => onOpen(e.date)}
      className="group flex w-full gap-5 rounded-2xl border border-transparent p-4 text-left transition hover:border-line hover:bg-surface"
    >
      <div className="w-12 shrink-0 text-center">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted">
          {d.toLocaleDateString(undefined, { weekday: "short" })}
        </div>
        <div className="font-serif text-[26px] leading-tight text-ink">{d.getDate()}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-serif text-[17px] text-ink">
            {e.title || relativeLabel(e.date) || d.toLocaleDateString(undefined, { month: "long", day: "numeric" })}
          </h3>
          {e.favourite && <Bookmark size={13} className="shrink-0 text-accent" fill="currentColor" aria-label="Bookmarked" />}
          {mood && <span title={mood.label}>{mood.emoji}</span>}
        </div>
        <p className="mt-1 line-clamp-2 font-serif text-[14.5px] leading-relaxed text-ink/65">
          {highlight ? <Highlight text={e.preview} term={highlight} /> : e.preview || <em className="text-muted">No text</em>}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {e.tags.map((t) => (
            <span key={t} className="rounded-full bg-accent-soft px-2 py-0.5 text-accent">#{t}</span>
          ))}
          {e.photoCount > 0 && (
            <span className="flex items-center gap-1"><ImageIcon size={12} /> {e.photoCount}</span>
          )}
          {e.voiceCount > 0 && (
            <span className="flex items-center gap-1"><Mic size={12} /> {e.voiceCount}</span>
          )}
          {e.videoCount > 0 && (
            <span className="flex items-center gap-1"><Video size={12} /> {e.videoCount}</span>
          )}
          <span>{e.wordCount} words</span>
        </div>
      </div>
      {cover && (
        <img src={cover} alt="" className="size-[72px] shrink-0 animate-fade-in rounded-xl object-cover" draggable={false} />
      )}
    </button>
  );
}

/** Mark every case-insensitive occurrence of `term` in `text`. */
function Highlight({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const parts = text.split(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === term.toLowerCase() ? <mark key={i} className="rounded bg-accent/20 px-0.5 text-ink">{p}</mark> : p,
      )}
    </>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-20 flex animate-fade-in flex-col items-center text-center text-muted">
      <Feather size={28} strokeWidth={1.5} />
      <p className="mt-3 font-serif text-lg text-ink">{title}</p>
      <p className="mt-1 text-sm">{body}</p>
    </div>
  );
}
