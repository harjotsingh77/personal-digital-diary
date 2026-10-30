import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Mic, Trash2 } from "lucide-react";
import { errorMessage } from "../lib/api";
import { MicRecording, formatDuration, LEVEL_INTERVAL_MS, type Recording } from "../lib/voice";
import { holdAutoLock } from "../hooks/useAutoLock";
import { registerFlush } from "../lib/saveRegistry";

/** Held longer than this and released → saved straight away (walkie-talkie). */
const HOLD_MS = 450;
/** Anything shorter is almost certainly an accidental click. */
const MIN_MS = 800;
/** Stop automatically so a forgotten recording can't grow forever. */
const MAX_MS = 30 * 60 * 1000;
/** Live waveform bars kept on screen. */
const LIVE_BARS = 140;

type Phase = "idle" | "starting" | "recording" | "saving";

interface Props {
  /** Store the finished recording (encrypt + attach to the entry). */
  onRecorded: (rec: Recording) => Promise<void>;
  /** What to show when not recording (the formatting toolbar). */
  children: React.ReactNode;
}

/**
 * WhatsApp-style voice notes. Press and hold the mic, speak, release to
 * save — or click it once to keep recording hands-free, then press ✓.
 * While recording, the toolbar row turns into a live waveform with a timer.
 */
export function VoiceRecorder({ onRecorded, children }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const rec = useRef<MicRecording | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;

  const finish = useCallback(async () => {
    const r = rec.current;
    if (!r || phaseRef.current !== "recording") return;
    rec.current = null;
    setHolding(false);
    if (r.elapsed() < MIN_MS) {
      r.cancel();
      setPhase("idle");
      setError("Too short — hold the mic while you speak, or click it once to start.");
      return;
    }
    setPhase("saving");
    phaseRef.current = "saving";
    try {
      await onRecordedRef.current(await r.stop());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPhase("idle");
    }
  }, []);

  const cancel = useCallback(() => {
    rec.current?.cancel();
    rec.current = null;
    setHolding(false);
    setPhase("idle");
  }, []);

  const start = useCallback(async (hold: boolean) => {
    if (phaseRef.current !== "idle") return;
    setError(null);
    setPhase("starting");
    phaseRef.current = "starting";
    setHolding(hold);
    try {
      const r = await MicRecording.start();
      if (phaseRef.current !== "starting") return r.cancel(); // unmounted meanwhile
      rec.current = r;
      setPhase("recording");
    } catch (e) {
      setError(errorMessage(e));
      setHolding(false);
      setPhase("idle");
    }
  }, []);

  // Pointer down on the mic starts recording right away. Releasing after a
  // real hold saves; a quick click leaves it recording ("locked").
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); // keep the editor's cursor where it was
    start(true);
    const onUp = () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setHolding(false);
      const r = rec.current;
      if (r && phaseRef.current === "recording" && r.elapsed() >= HOLD_MS) finish();
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // While recording: redraw the waveform, keep the diary from auto-locking,
  // Esc cancels, and locking the diary saves the note first.
  useEffect(() => {
    if (phase !== "recording") return;
    const release = holdAutoLock();
    const unregister = registerFlush(finish);
    const id = window.setInterval(() => {
      setTick((t) => t + 1);
      if ((rec.current?.elapsed() ?? 0) >= MAX_MS) finish();
    }, LEVEL_INTERVAL_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      release();
      unregister();
      window.clearInterval(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [phase, finish, cancel]);

  // Leaving the page mid-recording (switching day/view) keeps the note.
  useEffect(() => () => { finish(); }, [finish]);

  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(id);
  }, [error]);

  const active = phase === "recording" || phase === "saving";

  return (
    <div>
      {active ? (
        <div className="flex h-8 animate-fade-in items-center gap-2" role="group" aria-label="Recording voice note">
          <button
            type="button"
            title="Discard (Esc)"
            aria-label="Discard recording"
            onClick={cancel}
            disabled={phase === "saving"}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-ink/5 hover:text-danger disabled:opacity-30"
          >
            <Trash2 size={16} />
          </button>
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-danger" />
          <span className="w-10 shrink-0 text-sm tabular-nums text-ink">{formatDuration(rec.current?.elapsed() ?? 0)}</span>
          <LiveWave levels={rec.current?.levels ?? []} />
          <span className="shrink-0 text-xs text-muted">
            {phase === "saving" ? "Saving…" : holding ? "Release to save" : "Recording"}
          </span>
          <button
            type="button"
            title="Save voice note"
            aria-label="Save voice note"
            onClick={finish}
            disabled={phase === "saving"}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-paper transition hover:brightness-110 disabled:opacity-60"
          >
            {phase === "saving" ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={16} strokeWidth={2.5} />}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          {children}
          <button
            type="button"
            title="Voice note — hold to talk, or click to start"
            aria-label="Record voice note"
            onPointerDown={onPointerDown}
            onClick={(e) => { if (e.detail === 0) start(false); }} // keyboard (Enter/Space)
            className={`flex size-8 shrink-0 items-center justify-center rounded-md transition-colors ${
              phase === "starting" ? "bg-accent-soft text-accent" : "text-muted hover:bg-ink/5 hover:text-ink"
            }`}
          >
            {phase === "starting" ? <LoaderCircle size={16} className="animate-spin" /> : <Mic size={16} strokeWidth={2} />}
          </button>
        </div>
      )}
      {error && <p className="animate-fade-in px-1 pb-0.5 pt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Scrolling bars of the live input level, newest on the right. */
function LiveWave({ levels }: { levels: number[] }) {
  const recent = levels.slice(-LIVE_BARS);
  return (
    <div className="flex h-7 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden" aria-hidden>
      {recent.map((l, i) => (
        <span
          key={levels.length - recent.length + i}
          className="w-[3px] shrink-0 rounded-full bg-accent/70"
          style={{ height: `${Math.max(3, l * 26)}px` }}
        />
      ))}
    </div>
  );
}
