import { MOODS } from "../lib/moods";

interface Props {
  value: string | null;
  onChange: (mood: string | null) => void;
}

/** Row of mood emojis; clicking the selected one clears it. */
export function MoodPicker({ value, onChange }: Props) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Mood">
      {MOODS.map((m) => {
        const selected = value === m.id;
        return (
          <button
            key={m.id}
            role="radio"
            aria-checked={selected}
            title={m.label}
            onClick={() => onChange(selected ? null : m.id)}
            className={`flex h-9 items-center gap-1.5 rounded-full px-2.5 text-[19px] transition-all duration-200 ${
              selected
                ? "bg-accent-soft scale-105"
                : value
                  ? "opacity-35 grayscale hover:opacity-80 hover:grayscale-0"
                  : "opacity-70 hover:bg-ink/5 hover:opacity-100"
            }`}
          >
            <span>{m.emoji}</span>
            {selected && <span className="animate-fade-in text-xs font-medium text-accent">{m.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
