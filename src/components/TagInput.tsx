import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, X } from "lucide-react";
import { api, type TagCount } from "../lib/api";

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
}

const normalise = (t: string) => t.trim().replace(/^#+/, "").trim().toLowerCase().slice(0, 40);

/** Chip-style tag editor with suggestions from tags already in use. */
export function TagInput({ tags, onChange }: Props) {
  const [text, setText] = useState("");
  const [known, setKnown] = useState<TagCount[]>([]);
  const [focused, setFocused] = useState(false);
  /** Index of the arrow-key-selected suggestion; -1 = use the typed text. */
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focused) api.listTags().then(setKnown).catch(() => {});
  }, [focused]);

  const suggestions = useMemo(() => {
    const q = normalise(text);
    return known
      .filter((k) => !tags.includes(k.tag) && (!q || k.tag.includes(q)))
      .slice(0, 6);
  }, [known, tags, text]);

  const add = (raw: string) => {
    const t = normalise(raw);
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setText("");
    setHighlight(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      const pick = highlight >= 0 && suggestions[highlight] ? suggestions[highlight].tag : text.trim();
      if (pick) { e.preventDefault(); add(pick); }
    } else if (e.key === "Backspace" && !text && tags.length) {
      onChange(tags.slice(0, -1));
    } else if (e.key === "ArrowDown") {
      e.preventDefault(); setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); setHighlight((h) => Math.max(h - 1, -1));
    } else if (e.key === "Escape") {
      inputRef.current?.blur();
    }
  };

  return (
    <div className="relative">
      <div
        className="flex flex-wrap items-center gap-1.5 rounded-xl py-1"
        onClick={() => inputRef.current?.focus()}
      >
        <Hash size={14} className="text-muted" />
        {tags.map((t) => (
          <span key={t} className="flex animate-fade-in items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-xs text-accent">
            {t}
            <button
              aria-label={`Remove tag ${t}`}
              onClick={(e) => { e.stopPropagation(); onChange(tags.filter((x) => x !== t)); }}
              className="rounded-full p-0.5 hover:bg-accent/15"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => { setText(e.target.value); setHighlight(-1); }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); if (text.trim()) add(text); }}
          placeholder={tags.length ? "" : "Add tags…"}
          className="min-w-[90px] flex-1 bg-transparent py-0.5 text-[13px] text-ink outline-none placeholder:text-muted/60"
          aria-label="Add tag"
        />
      </div>
      {focused && suggestions.length > 0 && (
        <ul className="absolute left-5 top-full z-20 mt-1 min-w-[180px] animate-fade-in overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg shadow-black/5">
          {suggestions.map((s, i) => (
            <li key={s.tag}>
              <button
                onMouseDown={(e) => { e.preventDefault(); add(s.tag); }}
                onMouseEnter={() => setHighlight(i)}
                className={`flex w-full justify-between px-3 py-1.5 text-left text-[13px] ${i === highlight ? "bg-accent-soft text-accent" : "text-ink"}`}
              >
                <span>#{s.tag}</span>
                <span className="text-muted">{s.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
