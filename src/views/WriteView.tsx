import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  Bookmark, Check, ChevronLeft, ChevronRight, CircleAlert, ImagePlus, LoaderCircle, MoreHorizontal, RefreshCw, Type, Video, X,
} from "lucide-react";
import {
  api, emptyPayload, errorMessage, type Entry, type EntryPayload, type EntrySummary, type VideoNote, type VoiceNote,
} from "../lib/api";
import { addDays, fromISO, relativeLabel, todayISO } from "../lib/dates";
import { moodById } from "../lib/moods";
import { promptFor, TEMPLATES } from "../lib/prompts";
import { editorExtensions, readOnlyExtensions } from "../components/editor/extensions";
import { Toolbar } from "../components/editor/Toolbar";
import { useAutosave, type SaveStatus } from "../hooks/useAutosave";
import { MoodPicker } from "../components/MoodPicker";
import { TagInput } from "../components/TagInput";
import { PhotoStrip } from "../components/PhotoStrip";
import { VoiceRecorder } from "../components/VoiceRecorder";
import { VideoRecorder } from "../components/VideoRecorder";
import { collectVoiceNotes, insertVoiceNote, voiceNoteHTML } from "../components/editor/VoiceNoteNode";
import { collectVideoNotes, insertVideoNote, videoNoteHTML } from "../components/editor/VideoNoteNode";
import { timeStampHTML } from "../components/editor/TimeStampNode";
import type { Recording } from "../lib/voice";

interface Props {
  date: string;
  onDateChange: (date: string) => void;
  /** Called after each successful save (so streak/calendar can refresh). */
  onSaved?: () => void;
}

/** Keep in step with the `leaf-turn` animation in styles.css. */
const TURN_MS = 720;
/** Coming back to the page after this long starts a new time stamp. */
const NEW_SITTING_MS = 30 * 60 * 1000;

const countWords = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

const formatPageDate = (iso: string) =>
  fromISO(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

/** Printed in the corner: the page's number in its year, as in a dated diary. */
function dayOfYear(iso: string) {
  const d = fromISO(iso);
  return Math.round((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86_400_000) + 1;
}

/** The page turning over. Both faces show the same day, as one leaf of paper would. */
interface Leaf {
  direction: "forward" | "back";
  html: string;
  landed: boolean;
}

export function WriteView({ date, onDateChange, onSaved }: Props) {
  const { status, setStatus, schedule, flush } = useAutosave(onSaved);
  /** The day on the right (writable) page and on the left (read-only) one. */
  const [rightDate, setRightDate] = useState(date);
  const [leftDate, setLeftDate] = useState(() => addDays(date, -1));
  const [loadedRight, setLoadedRight] = useState<string | null>(null);
  const [loadedLeft, setLoadedLeft] = useState<string | null>(null);
  const [leaf, setLeaf] = useState<Leaf | null>(null);

  const [title, setTitle] = useState("");
  const [mood, setMood] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [favourite, setFavourite] = useState(false);
  const [words, setWords] = useState(0);
  const [hasMedia, setHasMedia] = useState(false);
  const [leftEntry, setLeftEntry] = useState<Entry | null>(null);
  const [memories, setMemories] = useState<EntrySummary[]>([]);
  const [promptShift, setPromptShift] = useState(0);
  const [panel, setPanel] = useState<"format" | "details" | null>(null);
  const [filming, setFilming] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);

  const pickPhoto = useRef<() => void>(() => {});
  const rightPage = useRef<HTMLDivElement>(null);
  const leftPage = useRef<HTMLDivElement>(null);

  // The full current payload; edits update it and queue an autosave.
  const draft = useRef<EntryPayload>(emptyPayload());
  const dateRef = useRef(rightDate);
  dateRef.current = rightDate;
  /** Whether the text has had a cursor in it since this day was opened. */
  const hadCursor = useRef(false);

  const update = useCallback(
    (patch: Partial<EntryPayload>) => {
      draft.current = { ...draft.current, ...patch };
      schedule(dateRef.current, draft.current);
    },
    [schedule],
  );

  const editor = useEditor({
    extensions: editorExtensions,
    editorProps: { attributes: { class: "diary-prose", spellcheck: "true" } },
    onUpdate: ({ editor: e }) => {
      const text = e.getText({ blockSeparator: "\n" });
      const voiceNotes = collectVoiceNotes(e.state.doc);
      const videoNotes = collectVideoNotes(e.state.doc);
      setWords(countWords(text));
      setHasMedia(voiceNotes.length + videoNotes.length > 0);
      update({ content: e.getHTML(), text, voiceNotes, videoNotes });
    },
    onFocus: () => { hadCursor.current = true; },
  });

  const leftEditor = useEditor({
    extensions: readOnlyExtensions,
    editable: false,
    editorProps: { attributes: { class: "diary-prose" } },
  });

  // Turning a page: the leaf lifts off one side and lands on the other, and
  // the pages underneath change while it covers them. Going forward the right
  // page changes first and the left once it's covered; going back, the reverse.
  const lastDate = useRef(date);
  useEffect(() => {
    if (date === lastDate.current) return;
    const forward = date > lastDate.current;
    lastDate.current = date;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const source = (forward ? rightPage : leftPage).current;
    const left = addDays(date, -1);
    if (reduced || !source) {
      setRightDate(date);
      setLeftDate(left);
      return;
    }
    setPanel(null);
    setLeaf({ direction: forward ? "forward" : "back", html: source.innerHTML, landed: false });
    if (forward) setRightDate(date);
    else setLeftDate(left);
    const id = window.setTimeout(() => {
      setRightDate(date);
      setLeftDate(left);
      setLeaf((l) => l && { ...l, landed: true });
    }, TURN_MS);
    return () => {
      window.clearTimeout(id);
      setRightDate(date);
      setLeftDate(left);
      setLeaf(null);
    };
  }, [date]);

  // Remove the leaf only once the page it landed on has loaded, or it would flash.
  useEffect(() => {
    if (leaf?.landed && loadedRight === rightDate && loadedLeft === leftDate) setLeaf(null);
  }, [leaf, loadedRight, loadedLeft, rightDate, leftDate]);

  // Load the entry whenever the right page changes (saving the previous one first).
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    (async () => {
      await flush();
      const entry = await api.getEntry(rightDate).catch(() => null);
      if (cancelled) return;
      draft.current = entry ? { ...emptyPayload(), ...entry } : emptyPayload();
      setTitle(draft.current.title);
      setMood(draft.current.mood);
      setTags(draft.current.tags);
      setPhotos(draft.current.photos);
      setFavourite(draft.current.favourite);
      setWords(countWords(draft.current.text));
      setHasMedia(draft.current.voiceNotes.length + draft.current.videoNotes.length > 0);
      setPromptShift(0);
      editor.commands.setContent(pageContent(draft.current, rightDate, entry?.updatedAt ?? null), { emitUpdate: false });
      hadCursor.current = false;
      setStatus(entry ? "saved" : "idle");
      setLoadedRight(rightDate);
      if (rightDate === todayISO()) { editor.commands.focus("end"); hadCursor.current = true; }
    })();
    return () => { cancelled = true; };
  }, [rightDate, editor, flush, setStatus]);

  useEffect(() => {
    if (!leftEditor) return;
    let cancelled = false;
    (async () => {
      const entry = await api.getEntry(leftDate).catch(() => null);
      if (cancelled) return;
      setLeftEntry(entry);
      leftEditor.commands.setContent(entry ? withAllNotes({ ...emptyPayload(), ...entry }) : "", { emitUpdate: false });
      setLoadedLeft(leftDate);
    })();
    return () => { cancelled = true; };
  }, [leftDate, leftEditor]);

  // On This Day is a slip tucked into today's spread only.
  const isToday = rightDate === todayISO();
  useEffect(() => {
    if (!isToday) return setMemories([]);
    let live = true;
    api.onThisDay(rightDate).then((m) => live && setMemories(m)).catch(() => {});
    return () => { live = false; };
  }, [isToday, rightDate]);

  /**
   * Encrypt a finished recording and put it on the page at the cursor — or,
   * if you turned the page mid-recording, at the end of the day it was
   * recorded on.
   */
  const saveVoice = useCallback(
    async (forDate: string, rec: Recording) => {
      try {
        const id = await api.addVoiceNote(rec.bytes);
        const note: VoiceNote = { id, mime: rec.mime, durationMs: rec.durationMs, recordedAt: rec.recordedAt, peaks: rec.peaks, transcript: "" };
        if (forDate === dateRef.current && editor) {
          insertVoiceNote(editor, note, hadCursor.current);
        } else {
          await flush();
          const entry = await api.getEntry(forDate);
          const base = entry ? { ...emptyPayload(), ...entry } : emptyPayload();
          const content = withAllNotes(base) + voiceNoteHTML(note);
          await api.saveEntry(forDate, { ...base, content, voiceNotes: [...base.voiceNotes, note] });
          onSaved?.();
        }
        await flush(); // a recording is too precious to leave to the debounce
      } catch (e) {
        throw new Error(`Couldn't save the voice note: ${errorMessage(e)}`);
      }
    },
    [editor, flush, onSaved],
  );

  const saveVideo = useCallback(
    async (forDate: string, note: VideoNote) => {
      if (forDate === dateRef.current && editor) {
        insertVideoNote(editor, note, hadCursor.current);
      } else {
        await flush();
        const entry = await api.getEntry(forDate);
        const base = entry ? { ...emptyPayload(), ...entry } : emptyPayload();
        const content = withAllNotes(base) + videoNoteHTML(note);
        await api.saveEntry(forDate, { ...base, content, videoNotes: [...base.videoNotes, note] });
        onSaved?.();
      }
      await flush();
    },
    [editor, flush, onSaved],
  );

  const today = todayISO();
  const pageIsEmpty = words === 0 && !hasMedia && photos.length === 0;
  const prompt = promptFor(rightDate, promptShift);
  const toggleFavourite = () => {
    const next = !favourite;
    setFavourite(next);
    update({ favourite: next });
  };
  const moodShown = moodById(mood);

  return (
    <div className="desk flex h-full flex-col">
      {/* Doubles as the window drag area. */}
      <header data-tauri-drag-region className="flex h-[44px] shrink-0 items-center justify-end gap-3 px-6">
        {date !== today && (
          <button
            onClick={() => onDateChange(today)}
            className="animate-fade-in rounded-full border border-line px-3 py-1 text-xs text-muted transition hover:border-accent hover:text-accent"
          >
            Back to today
          </button>
        )}
        <SaveIndicator status={status} />
      </header>

      <div className="relative flex min-h-0 flex-1 items-stretch justify-center px-7 pb-7">
        <div className="book" style={{ containerType: "inline-size" }}>
          <div className="book-spread">
            {/* Left page: the day before, to read. */}
            <section className="page page-left" aria-label={`Page for ${formatPageDate(leftDate)}`}>
              <div ref={leftPage} className="page-content">
                <PageHead date={leftDate} />
                <div className={`page-body page-lines ${memories.length ? "!pb-32" : ""}`}>
                  {leftEntry?.title && <p className="page-title">{leftEntry.title}</p>}
                  <EditorContent editor={leftEditor} />
                  {loadedLeft === leftDate && !leftEntry && <p className="page-empty">Nothing written on this day.</p>}
                  {leftEntry && leftEntry.photos.length > 0 && <PhotoStrip photos={leftEntry.photos} onChange={() => {}} readOnly />}
                </div>
                <span className="page-number page-number-left">{dayOfYear(leftDate)}</span>
              </div>
              {memories.length > 0 && <OnThisDay memories={memories} onOpen={onDateChange} />}
              <button className="page-corner page-corner-left" aria-label="Previous page" title="Previous page (⌘[)" onClick={() => onDateChange(addDays(date, -1))}>
                <ChevronLeft size={15} />
              </button>
            </section>

            <div className="book-gutter" aria-hidden />

            {/* Right page: the day being written. */}
            <section className="page page-right" aria-label={`Page for ${formatPageDate(rightDate)}`}>
              <button
                onClick={toggleFavourite}
                aria-pressed={favourite}
                aria-label={favourite ? "Remove bookmark" : "Bookmark this page"}
                title={favourite ? "Remove bookmark" : "Bookmark this page"}
                className={`page-ribbon ${favourite ? "page-ribbon-on" : ""}`}
              >
                <Bookmark size={15} fill={favourite ? "currentColor" : "none"} />
              </button>
              <div ref={rightPage} className={`page-content transition-opacity duration-150 ${loadedRight === rightDate ? "opacity-100" : "opacity-0"}`}>
                <PageHead date={rightDate} mood={moodShown?.emoji} />
                <div className="page-body page-lines">
                  {title && <p className="page-title">{title}</p>}
                  <EditorContent editor={editor} />
                  {pageIsEmpty && (
                    <div className="mt-4 animate-fade-in font-sans text-[12.5px] leading-relaxed text-muted">
                      <p className="flex items-start gap-1.5">
                        <button
                          className="text-left italic transition hover:text-ink"
                          title="Put this question on the page"
                          onClick={() => editor?.chain().focus("end").insertContent(`<blockquote><p>${prompt}</p></blockquote><p></p>`).run()}
                        >
                          {prompt}
                        </button>
                        <button onClick={() => setPromptShift((n) => n + 1)} aria-label="Another question" title="Another question" className="mt-0.5 shrink-0 transition hover:text-ink">
                          <RefreshCw size={12} />
                        </button>
                      </p>
                      <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        {TEMPLATES.map((t) => (
                          <button key={t.name} className="underline decoration-line underline-offset-4 transition hover:text-ink" onClick={() => editor?.chain().focus("end").insertContent(t.html).run()}>
                            {t.name}
                          </button>
                        ))}
                      </p>
                    </div>
                  )}
                  <PhotoStrip
                    photos={photos}
                    onChange={(p) => { setPhotos(p); update({ photos: p }); }}
                    openPicker={pickPhoto}
                  />
                </div>
              </div>

              {panel === "format" && editor && (
                <div className="page-popover animate-rise overflow-x-auto"><Toolbar editor={editor} /></div>
              )}
              {panel === "details" && (
                <div className="page-popover animate-rise space-y-3 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <MoodPicker value={mood} onChange={(m) => { setMood(m); update({ mood: m }); }} />
                    <button onClick={() => setPanel(null)} aria-label="Close" className="text-muted transition hover:text-ink"><X size={15} /></button>
                  </div>
                  <TagInput tags={tags} onChange={(t) => { setTags(t); update({ tags: t }); }} />
                  {title && (
                    <input
                      value={title}
                      onChange={(e) => { setTitle(e.target.value); update({ title: e.target.value }); }}
                      className="w-full bg-transparent text-[13px] text-ink outline-none"
                      aria-label="Page title"
                    />
                  )}
                  <p className="text-xs text-muted">{words} {words === 1 ? "word" : "words"}</p>
                </div>
              )}

              <div className="page-dock">
                {editor && (
                  <VoiceRecorder key={rightDate} onRecorded={(rec) => saveVoice(rightDate, rec)}>
                    <div className="flex items-center gap-0.5">
                      <DockButton label="Formatting" active={panel === "format"} onClick={() => setPanel(panel === "format" ? null : "format")}><Type size={16} /></DockButton>
                      <DockButton label="Add a photo" onClick={() => pickPhoto.current()}><ImagePlus size={16} /></DockButton>
                      <DockButton label="Record a video" onClick={() => { setVideoError(null); setFilming(true); }}><Video size={16} /></DockButton>
                      <DockButton label="Mood, tags and word count" active={panel === "details"} onClick={() => setPanel(panel === "details" ? null : "details")}><MoreHorizontal size={16} /></DockButton>
                    </div>
                  </VoiceRecorder>
                )}
                {videoError && <p className="px-1 pt-1 text-xs text-danger">{videoError}</p>}
              </div>
              <span className="page-number page-number-right">{dayOfYear(rightDate)}</span>
              {date < today && (
                <button className="page-corner page-corner-right" aria-label="Next page" title="Next page (⌘])" onClick={() => onDateChange(addDays(date, 1))}>
                  <ChevronRight size={15} />
                </button>
              )}
            </section>

            {leaf && (
              <div className={`leaf leaf-${leaf.direction}`} aria-hidden>
                <div className="leaf-face page"><div className="page-content" dangerouslySetInnerHTML={{ __html: leaf.html }} /></div>
                <div className="leaf-face leaf-face-back page"><div className="page-content" dangerouslySetInnerHTML={{ __html: leaf.html }} /></div>
              </div>
            )}
          </div>
        </div>
        {filming && (
          <VideoRecorder
            key={rightDate}
            onRecorded={(note) => saveVideo(rightDate, note)}
            onClose={() => setFilming(false)}
          />
        )}
      </div>
    </div>
  );
}

function PageHead({ date, mood }: { date: string; mood?: string }) {
  const rel = relativeLabel(date);
  return (
    <header className="page-head">
      <span className="page-date">{formatPageDate(date)}</span>
      {mood && <span className="ml-2 text-[15px]" aria-hidden>{mood}</span>}
      {rel && <span className="page-rel">{rel}</span>}
    </header>
  );
}

function OnThisDay({ memories, onOpen }: { memories: EntrySummary[]; onOpen: (d: string) => void }) {
  const [i, setI] = useState(0);
  const m = memories[i % memories.length];
  const when = fromISO(m.date).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  return (
    <aside className="memory-slip animate-rise" aria-label="On this day">
      <div className="flex items-baseline justify-between gap-2 font-sans text-[11px] text-muted">
        <span>On this day · {when}</span>
        {memories.length > 1 && (
          <button onClick={() => setI(i + 1)} className="tabular-nums transition hover:text-ink">{(i % memories.length) + 1}/{memories.length}</button>
        )}
      </div>
      <button onClick={() => onOpen(m.date)} className="mt-1 line-clamp-2 text-left text-[14.5px] leading-snug text-ink/80 transition hover:text-ink">
        {m.preview || m.title || "A page with no words"}
      </button>
    </aside>
  );
}

function DockButton(props: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      onMouseDown={(e) => e.preventDefault()} // keep the cursor in the text
      onClick={props.onClick}
      className={`flex size-8 items-center justify-center rounded-md transition-colors active:scale-95 ${props.active ? "bg-accent-soft text-accent" : "text-muted hover:bg-ink/5 hover:text-ink"}`}
    >
      {props.children}
    </button>
  );
}

/**
 * Entry HTML with every note in it. Notes recorded before they lived inside
 * the text only exist in the lists; those are added at the end.
 */
function withAllNotes(p: EntryPayload): string {
  const missing = p.voiceNotes.filter((n) => !p.content.includes(`data-id="${n.id}"`));
  const missingVideo = p.videoNotes.filter((n) => !p.content.includes(`data-id="${n.id}"`));
  return (p.content || "") + missing.map(voiceNoteHTML).join("") + missingVideo.map(videoNoteHTML).join("");
}

/**
 * What the editor opens with. Writing on today's page starts the way it would
 * on paper, with the time at the top of the sitting. This isn't saved until
 * something is actually written or recorded.
 */
function pageContent(p: EntryPayload, date: string, updatedAt: number | null): string {
  const html = withAllNotes(p);
  const now = Date.now();
  const newSitting = updatedAt === null || now - updatedAt > NEW_SITTING_MS;
  return date === todayISO() && newSitting ? `${html}${timeStampHTML(now)}<p></p>` : html;
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const content = {
    idle: null,
    unsaved: null,
    saving: <><LoaderCircle size={12} className="animate-spin" /> Saving</>,
    saved: <><Check size={12} /> Saved</>,
    error: <span className="flex items-center gap-1.5 text-danger"><CircleAlert size={13} /> Couldn't save. Retrying.</span>,
  }[status];
  return <div className="flex h-5 items-center gap-1.5 text-[11.5px] text-muted/80">{content}</div>;
}
