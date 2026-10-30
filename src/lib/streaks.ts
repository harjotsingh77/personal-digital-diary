import { fromISO } from "./dates";

/** A date as a whole day count, so consecutive days differ by exactly 1. */
export const day = (iso: string) => {
  const d = fromISO(iso);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
};

/** The most consecutive days in a list of day counts, in any order. */
export function longestRun(days: number[]): number {
  const sorted = [...days].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  sorted.forEach((d, i) => {
    run = i > 0 && d === sorted[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}
