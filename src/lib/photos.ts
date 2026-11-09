import { api } from "./api";
import { device } from "./platform";

/** Downscale anything bigger than this (longest side, px) before storing. */
const MAX_SIDE = 2400;
const MAX_UNTOUCHED_BYTES = 3 * 1024 * 1024;

/**
 * Turn a picked/dropped/pasted file into the bytes we store: small images
 * are kept as-is; large camera photos are re-encoded as JPEG at 2400px,
 * which keeps the diary folder small without visible quality loss.
 */
export async function prepareImage(file: Blob): Promise<Uint8Array> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`That file isn't an image this ${device} can open.`);
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  if (scale === 1 && file.size <= MAX_UNTOUCHED_BYTES) {
    bitmap.close();
    return new Uint8Array(await file.arrayBuffer());
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.86));
  if (!blob) throw new Error("Couldn't process that image.");
  return new Uint8Array(await blob.arrayBuffer());
}

// Decrypted photos are cached as blob: URLs for this unlocked session only.
const cache = new Map<string, Promise<string>>();

export function photoUrl(id: string): Promise<string> {
  let url = cache.get(id);
  if (!url) {
    url = api.getPhoto(id).then((buf) => URL.createObjectURL(new Blob([buf])));
    url.catch(() => cache.delete(id));
    cache.set(id, url);
  }
  return url;
}

/** Forget all decrypted images (called when the diary locks). */
export function clearPhotoCache() {
  for (const p of cache.values()) p.then(URL.revokeObjectURL, () => {});
  cache.clear();
}
