import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Trash2, X } from "lucide-react";
import { errorMessage, type VideoNote } from "../lib/api";
import { formatDuration } from "../lib/voice";
import { openCamera, VideoRecording } from "../lib/video";
import { holdAutoLock } from "../hooks/useAutoLock";
import { registerFlush } from "../lib/saveRegistry";

const TICK_MS = 250;

type Phase = "opening" | "ready" | "recording" | "saving";

interface Props {
  onRecorded: (note: VideoNote) => Promise<void>;
  onClose: () => void;
}

/**
 * The camera, over the page. Nothing records until the button is pressed.
 * Esc discards; switching page or locking the diary keeps what was recorded.
 */
export function VideoRecorder({ onRecorded, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("opening");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const preview = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<VideoRecording | null>(null);
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const stopCamera = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  const finish = useCallback(async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setPhase("saving");
    try {
      const note = await r.stop();
      stopCamera();
      await onRecordedRef.current(note);
      onCloseRef.current();
    } catch (e) {
      stopCamera();
      setError(`Couldn't save the video: ${errorMessage(e)}`);
      setPhase("ready");
    }
  }, []);

  const discard = useCallback(async () => {
    const r = rec.current;
    rec.current = null;
    stopCamera();
    onCloseRef.current();
    await r?.cancel();
  }, []);

  useEffect(() => {
    let live = true;
    openCamera().then(
      (s) => {
        if (!live) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        if (preview.current) preview.current.srcObject = s;
        setPhase("ready");
      },
      (e) => { if (live) { setError(errorMessage(e)); setPhase("ready"); } },
    );
    return () => {
      live = false;
      // Leaving mid-recording keeps the video; otherwise just close the camera.
      if (rec.current) finish();
      else stopCamera();
    };
  }, [finish]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); discard(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [discard]);

  useEffect(() => {
    if (phase !== "recording") return;
    const release = holdAutoLock();
    const unregister = registerFlush(finish);
    const id = window.setInterval(() => {
      const r = rec.current;
      if (!r) return;
      setElapsed(r.elapsed());
      if (r.error) finish();
    }, TICK_MS);
    return () => { release(); unregister(); window.clearInterval(id); };
  }, [phase, finish]);

  function start() {
    if (!stream.current || !preview.current) return;
    setError(null);
    setElapsed(0);
    try {
      rec.current = VideoRecording.start(stream.current, preview.current);
      setPhase("recording");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex animate-fade-in flex-col items-center justify-center gap-4 bg-black/80 p-8 backdrop-blur-sm" role="dialog" aria-label="Record a video note">
      <div className="relative aspect-video max-h-[70%] w-full max-w-[720px] overflow-hidden rounded-lg bg-black shadow-2xl">
        <video ref={preview} autoPlay muted playsInline className="size-full -scale-x-100 object-cover" />
        {phase === "recording" && (
          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/55 px-3 py-1 text-[13px] tabular-nums text-white">
            <span className="size-2 animate-pulse rounded-full bg-[#e0584d]" />
            {formatDuration(elapsed)}
          </div>
        )}
        {phase === "opening" && (
          <div className="absolute inset-0 flex items-center justify-center text-white/70"><LoaderCircle className="animate-spin" /></div>
        )}
      </div>

      {error && <p className="max-w-[520px] text-center text-[13px] text-[#f0a79f]" role="alert">{error}</p>}

      <div className="flex items-center gap-5">
        <button
          type="button"
          onClick={discard}
          disabled={phase === "saving"}
          title="Discard (Esc)"
          aria-label={phase === "recording" ? "Discard video" : "Close camera"}
          className="flex size-11 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 active:scale-95 disabled:opacity-40"
        >
          {phase === "recording" ? <Trash2 size={18} /> : <X size={18} />}
        </button>
        {phase === "recording" || phase === "saving" ? (
          <button
            type="button"
            onClick={finish}
            disabled={phase === "saving"}
            aria-label="Stop and save video"
            title="Stop and save"
            className="flex size-16 items-center justify-center rounded-full bg-white text-black transition hover:brightness-90 active:scale-95 disabled:opacity-70"
          >
            {phase === "saving" ? <LoaderCircle size={22} className="animate-spin" /> : <Check size={24} strokeWidth={2.5} />}
          </button>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={phase === "opening" || !stream.current}
            aria-label="Start recording"
            title="Start recording"
            className="flex size-16 items-center justify-center rounded-full border-4 border-white transition active:scale-95 disabled:opacity-40"
          >
            <span className="size-11 rounded-full bg-[#e0584d]" />
          </button>
        )}
        <span className="size-11" />
      </div>
    </div>
  );
}
