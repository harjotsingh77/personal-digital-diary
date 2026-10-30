import { useEffect, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { prepareImage } from "../lib/photos";
import { usePhotoUrl } from "../hooks/usePhotoUrl";

interface Props {
  photos: string[];
  onChange: (photos: string[]) => void;
  /** Filled in with a function that opens the file picker, for a button elsewhere. */
  openPicker?: React.RefObject<() => void>;
  /** Just show the photos: no adding, dropping, pasting or removing. */
  readOnly?: boolean;
}

/**
 * Attached photos: add via button, drag & drop onto the page, or paste.
 * Each image is encrypted by the backend before it's written to disk.
 */
export function PhotoStrip({ photos, onChange, openPicker, readOnly }: Props) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Uploads finish asynchronously; always append to the latest list.
  const photosRef = useRef(photos);
  photosRef.current = photos;

  async function addFiles(files: Iterable<File>) {
    setError(null);
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      setBusy((b) => b + 1);
      try {
        const id = await api.addPhoto(await prepareImage(f));
        onChange([...photosRef.current, id]);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy((b) => b - 1);
      }
    }
  }
  const addRef = useRef(addFiles);
  addRef.current = addFiles;

  // Window-level drop + paste so you can drop a photo anywhere on the page.
  useEffect(() => {
    if (readOnly) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const onLeave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false); } };
    const onOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addRef.current(Array.from(e.dataTransfer!.files));
    };
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); addRef.current(files); }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste, true);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste, true);
    };
  }, [readOnly]);

  useEffect(() => {
    if (openPicker) openPicker.current = () => fileRef.current?.click();
  }, [openPicker]);

  const remove = (id: string) => {
    onChange(photos.filter((p) => p !== id));
    api.deletePhoto(id).catch(() => {});
  };

  return (
    <div className={photos.length || busy || dragging || error ? "mt-4" : ""}>
      <div className="flex flex-wrap gap-2">
        {photos.map((id) => (
          <Thumb key={id} id={id} onOpen={() => setViewing(id)} onRemove={readOnly ? undefined : () => remove(id)} />
        ))}
        {Array.from({ length: busy }, (_, i) => (
          <div key={`busy${i}`} className="flex size-24 items-center justify-center rounded-xl bg-ink/5 text-muted">
            <LoaderCircle size={18} className="animate-spin" />
          </div>
        ))}
        {dragging && (
          <div className="flex size-24 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-accent bg-accent-soft text-xs text-accent">
            <ImagePlus size={18} strokeWidth={1.75} />
            Drop here
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
        />
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {viewing && <Lightbox id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function Thumb({ id, onOpen, onRemove }: { id: string; onOpen: () => void; onRemove?: () => void }) {
  const url = usePhotoUrl(id);
  return (
    <div className="group relative size-24 animate-fade-in overflow-hidden rounded-xl bg-ink/5">
      {url && (
        <button onClick={onOpen} className="size-full" aria-label="View photo">
          <img src={url} alt="" className="size-full object-cover transition duration-300 group-hover:scale-105" draggable={false} />
        </button>
      )}
      {onRemove && <button
        onClick={onRemove}
        aria-label="Remove photo"
        className="absolute right-1 top-1 rounded-full bg-black/55 p-1 text-white opacity-0 transition group-hover:opacity-100"
      >
        <X size={12} />
      </button>}
    </div>
  );
}

export function Lightbox({ id, onClose }: { id: string; onClose: () => void }) {
  const url = usePhotoUrl(id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/75 p-10 backdrop-blur-sm">
      {url && <img src={url} alt="" className="max-h-full max-w-full animate-rise rounded-lg shadow-2xl" />}
    </div>
  );
}
