import { useEffect, useMemo, useState } from "react";
import { Images, LoaderCircle } from "lucide-react";
import { api, type PhotoRef } from "../lib/api";
import { formatMonth, fromISO, monthOf } from "../lib/dates";
import { usePhotoUrl } from "../hooks/usePhotoUrl";

export function GalleryView({ onOpen }: { onOpen: (date: string) => void }) {
  const [photos, setPhotos] = useState<PhotoRef[] | null>(null);

  useEffect(() => {
    api.listPhotos().then(setPhotos).catch(() => setPhotos([]));
  }, []);

  const groups = useMemo(() => {
    const out: { month: string; items: PhotoRef[] }[] = [];
    for (const p of photos ?? []) {
      const m = monthOf(p.date);
      if (out[out.length - 1]?.month !== m) out.push({ month: m, items: [] });
      out[out.length - 1].items.push(p);
    }
    return out;
  }, [photos]);

  return (
    <div className="flex h-full flex-col">
      <header data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[920px] px-10 pb-24 max-sm:px-4">
          <div className="flex items-baseline justify-between">
            <h1 className="font-serif text-[30px] text-ink">Photos</h1>
            {photos && photos.length > 0 && <p className="text-sm tabular-nums text-muted">{photos.length}</p>}
          </div>

          {photos?.length === 0 && (
            <div className="mt-24 flex animate-fade-in flex-col items-center text-center text-muted">
              <Images size={28} strokeWidth={1.5} />
              <p className="mt-3 font-serif text-lg text-ink">No photos yet</p>
              <p className="mt-1 text-sm">Photos you add to a page will collect here.</p>
            </div>
          )}

          {groups.map((g) => (
            <section key={g.month} className="mt-7">
              <h2 className="mb-2 text-sm text-muted">{formatMonth(g.month)}</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                {g.items.map((p) => <Tile key={p.id} photo={p} onOpen={onOpen} />)}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function Tile({ photo, onOpen }: { photo: PhotoRef; onOpen: (date: string) => void }) {
  const url = usePhotoUrl(photo.id);
  const day = fromISO(photo.date).toLocaleDateString(undefined, { month: "long", day: "numeric" });
  return (
    <button
      onClick={() => onOpen(photo.date)}
      title={`Open ${day}`}
      aria-label={`Open the page for ${day}`}
      className="group relative aspect-square overflow-hidden rounded-md bg-ink/5"
    >
      {url ? (
        <img src={url} alt="" draggable={false} className="size-full animate-fade-in object-cover transition duration-300 group-hover:scale-[1.03]" />
      ) : (
        <span className="flex size-full items-center justify-center text-muted"><LoaderCircle size={16} className="animate-spin" /></span>
      )}
      <span className="absolute bottom-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[11px] text-white opacity-0 transition group-hover:opacity-100">{day}</span>
    </button>
  );
}
