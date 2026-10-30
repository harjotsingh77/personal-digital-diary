import { useEffect, useRef, useState } from "react";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type Editor, type ReactNodeViewProps,
} from "@tiptap/react";
import { GripVertical, LoaderCircle, Pause, Play, Trash2 } from "lucide-react";
import { api, errorMessage, type VoiceNote } from "../../lib/api";
import { transcriptionLanguage } from "../../lib/preferences";
import { formatDuration, voiceUrl } from "../../lib/voice";

/**
 * A voice note as a block inside the entry text: it is inserted where the
 * cursor is and can be dragged anywhere by its grip (or cut/pasted). The
 * audio is an encrypted file; the node only carries its id and metadata.
 */
export const VoiceNoteNode = Node.create({
  name: "voiceNote",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    const attr = <T,>(name: string, fallback: T, parse: (v: string) => T, render: (v: T) => string) => ({
      default: fallback,
      parseHTML: (el: HTMLElement) => {
        const v = el.getAttribute(name);
        return v == null ? fallback : parse(v);
      },
      renderHTML: (attrs: Record<string, unknown>) => ({ [name]: render(attrs[toCamel(name)] as T) }),
    });
    return {
      id: attr("data-id", "", String, String),
      mime: attr("data-mime", "audio/mp4", String, String),
      durationMs: attr("data-duration-ms", 0, Number, String),
      recordedAt: attr("data-recorded-at", 0, Number, String),
      peaks: attr<number[]>("data-peaks", [], (v) => v.split(",").filter(Boolean).map(Number), (v) => v.join(",")),
      transcript: attr("data-transcript", "", String, String),
    };
  },

  parseHTML() {
    return [{ tag: "div[data-voice-note]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-voice-note": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(VoiceNoteView);
  },
});

/** "data-duration-ms" → "durationMs" */
function toCamel(dataAttr: string) {
  return dataAttr.replace(/^data-/, "").replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Stored HTML for a note — used when adding one to an entry that isn't open. */
export function voiceNoteHTML(n: VoiceNote): string {
  return `<div data-voice-note="" data-id="${esc(n.id)}" data-mime="${esc(n.mime)}" data-duration-ms="${n.durationMs}" data-recorded-at="${n.recordedAt}" data-peaks="${n.peaks.join(",")}" data-transcript="${esc(n.transcript ?? "")}"></div>`;
}

/** Every voice note in the document, top to bottom. */
export function collectVoiceNotes(doc: PMNode): VoiceNote[] {
  const out: VoiceNote[] = [];
  doc.descendants((node) => {
    if (node.type.name === "voiceNote" && node.attrs.id) out.push({ ...(node.attrs as VoiceNote) });
    return node.isBlock; // no need to look inside paragraphs
  });
  return out;
}

/** Put a note at the cursor (or at the end if the text was never clicked into). */
export function insertVoiceNote(editor: Editor, note: VoiceNote, atCursor: boolean) {
  const chain = editor.chain();
  (atCursor ? chain.focus() : chain.focus("end")).insertContent({ type: "voiceNote", attrs: note }).run();
}

function VoiceNoteView({ node, selected, editor, getPos, updateAttributes }: ReactNodeViewProps) {
  // The trash button deletes the file too, so keep that out of undo history
  // (⌘Z would bring back a note with no audio). Backspace-deletes stay
  // undoable; their files are cleaned up when the diary locks.
  const remove = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize).setMeta("addToHistory", false));
    api.deleteVoiceNote(node.attrs.id).catch(() => {});
  };
  return (
    <NodeViewWrapper className="voice-note py-1" contentEditable={false}>
      <Player note={node.attrs as VoiceNote} selected={selected} onRemove={remove} editable={editor.isEditable} />
      <Transcript note={node.attrs as VoiceNote} editable={editor.isEditable} onDone={(transcript) => updateAttributes({ transcript })} />
    </NodeViewWrapper>
  );
}

/** The note's words, made on this Mac on request. */
function Transcript({ note, editable, onDone }: { note: VoiceNote; editable: boolean; onDone: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.transcribeVoiceNote(note.id, transcriptionLanguage()));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (note.transcript) {
    return <p className="mt-1 max-w-[440px] font-sans text-[13px] leading-relaxed text-muted">{note.transcript}</p>;
  }
  if (!editable) return null;
  return (
    <div className="mt-0.5 max-w-[440px] font-sans text-[11.5px] leading-normal text-muted">
      <button type="button" onClick={run} disabled={busy} className="underline decoration-line underline-offset-4 transition hover:text-ink disabled:opacity-60">
        {busy ? "Listening…" : "Turn into text"}
      </button>
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}

/** Only one note plays at a time. */
let stopCurrent: (() => void) | null = null;
const SPEEDS = [1, 1.5, 2];

function Player({ note, selected, onRemove, editable }: { note: VoiceNote; selected: boolean; onRemove: () => void; editable: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(0); // ms
  const [speed, setSpeed] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const duration = note.durationMs;

  // Smooth progress while playing (timeupdate only fires ~4×/s).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const step = () => {
      if (audio.current) setPosition(audio.current.currentTime * 1000);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Stable identity, so `stopCurrent === pause` works across renders.
  const pause = useRef(() => audio.current?.pause()).current;

  useEffect(() => () => {
    pause();
    if (stopCurrent === pause) stopCurrent = null;
  }, [pause]);

  async function load(): Promise<HTMLAudioElement | null> {
    if (audio.current) return audio.current;
    setLoading(true);
    try {
      const a = new Audio(await voiceUrl(note));
      a.preload = "auto";
      a.onplay = () => setPlaying(true);
      a.onpause = () => setPlaying(false);
      a.onended = () => { setPlaying(false); setPosition(0); a.currentTime = 0; };
      audio.current = a;
      return a;
    } catch {
      setFailed(true);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    if (playing) return pause();
    const a = await load();
    if (!a) return;
    if (stopCurrent && stopCurrent !== pause) stopCurrent();
    stopCurrent = pause;
    a.playbackRate = speed;
    a.play().catch(() => setFailed(true));
  }

  async function seek(fraction: number) {
    const a = await load();
    if (!a) return;
    const ms = Math.min(duration, Math.max(0, fraction * duration));
    a.currentTime = ms / 1000;
    setPosition(ms);
  }

  function cycleSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audio.current) audio.current.playbackRate = next;
  }

  const progress = duration ? Math.min(1, position / duration) : 0;
  const peaks = note.peaks.length ? note.peaks : Array.from({ length: 48 }, () => 12);
  const recordedAt = note.recordedAt
    ? new Date(note.recordedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div
      className={`group relative flex w-full max-w-[440px] animate-fade-in items-center gap-3 rounded-2xl border bg-surface py-2.5 pl-2.5 pr-3 font-sans leading-normal transition-shadow ${
        selected ? "border-accent/60 ring-2 ring-accent/25" : "border-line"
      }`}
      onMouseLeave={() => setConfirming(false)}
    >
      <span
        data-drag-handle
        draggable="true"
        title="Drag to move"
        className="absolute -left-7 top-1/2 flex h-8 w-5 -translate-y-1/2 cursor-grab items-center justify-center rounded text-muted opacity-0 transition hover:bg-ink/5 hover:text-ink active:cursor-grabbing group-hover:opacity-100"
      >
        <GripVertical size={15} />
      </span>
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause voice note" : "Play voice note"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-paper transition hover:brightness-110"
      >
        {loading ? (
          <LoaderCircle size={16} className="animate-spin" />
        ) : playing ? (
          <Pause size={15} fill="currentColor" strokeWidth={0} />
        ) : (
          <Play size={15} fill="currentColor" strokeWidth={0} className="translate-x-px" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Voice note position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration / 1000)}
          aria-valuenow={Math.round(position / 1000)}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seek((e.clientX - r.left) / r.width);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") seek((position + 5000) / duration);
            else if (e.key === "ArrowLeft") seek((position - 5000) / duration);
            else if (e.key === " ") { e.preventDefault(); toggle(); }
          }}
          className="flex h-7 cursor-pointer items-center justify-between gap-[2px] rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {peaks.map((p, i) => (
            <span
              key={i}
              className={`w-[3px] shrink-0 rounded-full transition-colors duration-150 ${
                (i + 0.5) / peaks.length <= progress ? "bg-accent" : "bg-ink/20"
              }`}
              style={{ height: `${Math.max(3, (p / 100) * 26)}px` }}
            />
          ))}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] tabular-nums text-muted">
          <span>{failed ? <span className="text-danger">Couldn't play this note</span> : formatDuration(playing || position ? position : duration)}</span>
          {recordedAt && <span className="text-muted/70">· {recordedAt}</span>}
        </div>
      </div>

      <button
        type="button"
        onClick={cycleSpeed}
        title="Playback speed"
        className="shrink-0 rounded-full bg-ink/5 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted transition hover:bg-ink/10 hover:text-ink"
      >
        {speed}×
      </button>
      {editable && <button
        type="button"
        onClick={() => (confirming ? onRemove() : setConfirming(true))}
        title={confirming ? "Click again to delete" : "Delete voice note"}
        aria-label={confirming ? "Confirm delete voice note" : "Delete voice note"}
        className={`flex h-7 shrink-0 items-center justify-center rounded-md text-xs transition ${
          confirming
            ? "bg-danger px-2 text-paper"
            : "w-7 text-muted opacity-0 hover:bg-ink/5 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        }`}
      >
        {confirming ? "Delete" : <Trash2 size={14} />}
      </button>}
    </div>
  );
}
