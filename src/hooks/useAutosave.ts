import { useCallback, useEffect, useRef, useState } from "react";
import { api, type EntryPayload } from "../lib/api";
import { registerFlush } from "../lib/saveRegistry";

export type SaveStatus = "idle" | "unsaved" | "saving" | "saved" | "error";

/** Wait this long after the last keystroke before saving… */
const DEBOUNCE_MS = 1500;
/** …but never let unsaved changes sit longer than this while typing. */
const MAX_WAIT_MS = 5000;

/**
 * Debounced autosave. `schedule()` queues the latest payload for a date;
 * `flush()` saves immediately. Saves run strictly one after another so an
 * older version can never overwrite a newer one.
 */
export function useAutosave(onSaved?: (date: string) => void) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const pending = useRef<{ date: string; payload: EntryPayload } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const firstDirtyAt = useRef<number | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const flush = useCallback((): Promise<void> => {
    window.clearTimeout(timer.current);
    const job = pending.current;
    if (!job) return chain.current;
    pending.current = null;
    firstDirtyAt.current = null;

    chain.current = chain.current.then(async () => {
      setStatus("saving");
      try {
        await api.saveEntry(job.date, job.payload);
        // Only report "saved" if nothing newer was queued meanwhile.
        setStatus(pending.current ? "unsaved" : "saved");
        onSavedRef.current?.(job.date);
      } catch (e) {
        console.error("Autosave failed", e);
        setStatus("error");
        // Keep the work so the next flush retries it.
        if (!pending.current) pending.current = job;
      }
    });
    return chain.current;
  }, []);

  const schedule = useCallback(
    (date: string, payload: EntryPayload) => {
      pending.current = { date, payload };
      setStatus("unsaved");
      const now = Date.now();
      firstDirtyAt.current ??= now;
      const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now - firstDirtyAt.current)));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, wait);
    },
    [flush],
  );

  // Save before locking, when the window loses focus, and on unmount.
  useEffect(() => {
    const unregister = registerFlush(flush);
    window.addEventListener("blur", flush);
    return () => {
      unregister();
      window.removeEventListener("blur", flush);
      flush();
    };
  }, [flush]);

  return { status, setStatus, schedule, flush };
}
