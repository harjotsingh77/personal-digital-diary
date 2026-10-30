// Lets components with unsaved work (the editor) register a flush function,
// so the app can save everything before it locks and forgets the key.

type Flush = () => Promise<void>;
const flushers = new Set<Flush>();

export function registerFlush(fn: Flush): () => void {
  flushers.add(fn);
  return () => flushers.delete(fn);
}

export async function flushAll(): Promise<void> {
  await Promise.allSettled([...flushers].map((f) => f()));
}
