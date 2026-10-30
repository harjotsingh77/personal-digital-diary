import { useState } from "react";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type Editor, type ReactNodeViewProps,
} from "@tiptap/react";
import { GripVertical, Play, Trash2, VideoOff } from "lucide-react";
import { api, type VideoNote } from "../../lib/api";
import { formatDuration } from "../../lib/voice";
import { videoUrl } from "../../lib/video";

/** A video as a block on the page. The node carries metadata; frames stay encrypted on disk. */
export const VideoNoteNode = Node.create({
  name: "videoNote",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: "", parseHTML: (el) => el.getAttribute("data-id") ?? "", renderHTML: (a) => ({ "data-id": a.id }) },
      mime: { default: "video/mp4", parseHTML: (el) => el.getAttribute("data-mime") ?? "video/mp4", renderHTML: (a) => ({ "data-mime": a.mime }) },
      durationMs: { default: 0, parseHTML: (el) => Number(el.getAttribute("data-duration-ms")) || 0, renderHTML: (a) => ({ "data-duration-ms": String(a.durationMs) }) },
      recordedAt: { default: 0, parseHTML: (el) => Number(el.getAttribute("data-recorded-at")) || 0, renderHTML: (a) => ({ "data-recorded-at": String(a.recordedAt) }) },
      poster: { default: "", parseHTML: (el) => el.getAttribute("data-poster") ?? "", renderHTML: (a) => ({ "data-poster": a.poster }) },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-video-note]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-video-note": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(VideoNoteView);
  },
});

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Stored HTML for a video, used when adding one to an entry that isn't open. */
export function videoNoteHTML(n: VideoNote): string {
  return `<div data-video-note="" data-id="${esc(n.id)}" data-mime="${esc(n.mime)}" data-duration-ms="${n.durationMs}" data-recorded-at="${n.recordedAt}" data-poster="${esc(n.poster)}"></div>`;
}

export function collectVideoNotes(doc: PMNode): VideoNote[] {
  const out: VideoNote[] = [];
  doc.descendants((node) => {
    if (node.type.name === "videoNote" && node.attrs.id) out.push({ ...(node.attrs as VideoNote) });
    return node.isBlock;
  });
  return out;
}

export function insertVideoNote(editor: Editor, note: VideoNote, atCursor: boolean) {
  const chain = editor.chain();
  (atCursor ? chain.focus() : chain.focus("end")).insertContent({ type: "videoNote", attrs: note }).run();
}

function VideoNoteView({ node, selected, editor, getPos }: ReactNodeViewProps) {
  const note = node.attrs as VideoNote;
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // As with voice notes, the trash button deletes the file, so it stays out of undo history.
  const remove = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize).setMeta("addToHistory", false));
    api.deleteVideoNote(note.id).catch(() => {});
  };

  const time = note.recordedAt
    ? new Date(note.recordedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <NodeViewWrapper className="video-note py-2" contentEditable={false}>
      <figure
        className={`group relative aspect-video w-full max-w-[420px] overflow-hidden rounded-md bg-black font-sans shadow-[0_2px_10px_var(--shadow)] ${selected ? "ring-2 ring-accent/50" : ""}`}
        onMouseLeave={() => setConfirming(false)}
      >
        {failed ? (
          <div className="flex size-full flex-col items-center justify-center gap-2 px-6 text-center text-[12.5px] text-white/70">
            <VideoOff size={20} />
            This video isn't on this Mac. It may have been left out of a backup.
          </div>
        ) : playing ? (
          <video src={videoUrl(note)} poster={note.poster || undefined} controls autoPlay playsInline onError={() => setFailed(true)} className="size-full object-contain" />
        ) : (
          <button type="button" onClick={() => setPlaying(true)} aria-label="Play video note" className="relative block size-full">
            {note.poster && <img src={note.poster} alt="" draggable={false} className="size-full object-cover" />}
            <span className="absolute inset-0 m-auto flex size-12 items-center justify-center rounded-full bg-black/55 text-white transition group-hover:bg-black/70">
              <Play size={18} fill="currentColor" strokeWidth={0} className="translate-x-px" />
            </span>
            <span className="absolute bottom-2 left-2 rounded bg-black/55 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
              {formatDuration(note.durationMs)}{time ? ` · ${time}` : ""}
            </span>
          </button>
        )}
        {editor.isEditable && (
          <>
            <span data-drag-handle draggable="true" title="Drag to move" className="absolute left-1.5 top-1.5 flex size-7 cursor-grab items-center justify-center rounded bg-black/55 text-white opacity-0 transition group-hover:opacity-100">
              <GripVertical size={14} />
            </span>
            <button
              type="button"
              onClick={() => (confirming ? remove() : setConfirming(true))}
              title={confirming ? "Click again to delete" : "Delete video"}
              aria-label={confirming ? "Confirm delete video" : "Delete video"}
              className={`absolute right-1.5 top-1.5 flex h-7 items-center justify-center rounded text-xs text-white transition ${confirming ? "bg-danger px-2" : "w-7 bg-black/55 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
            >
              {confirming ? "Delete" : <Trash2 size={13} />}
            </button>
          </>
        )}
      </figure>
    </NodeViewWrapper>
  );
}
