import { useEffect, useState } from "react";
import { photoUrl } from "../lib/photos";

/** Decrypted blob: URL for a photo id (null while loading or on error). */
export function usePhotoUrl(id: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return setUrl(null);
    let live = true;
    photoUrl(id).then((u) => live && setUrl(u), () => live && setUrl(null));
    return () => { live = false; };
  }, [id]);
  return url;
}
