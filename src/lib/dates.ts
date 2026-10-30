// Dates are handled as local "YYYY-MM-DD" strings everywhere — that's also
// the key the backend uses — so there are no timezone surprises.

const pad = (n: number) => String(n).padStart(2, "0");

export const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function fromISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export const todayISO = () => toISO(new Date());

export function addDays(iso: string, n: number): string {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** "YYYY-MM" for the month containing `iso`. */
export const monthOf = (iso: string) => iso.slice(0, 7);

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export const formatWeekday = (iso: string) =>
  fromISO(iso).toLocaleDateString(undefined, { weekday: "long" });

export const formatLong = (iso: string) =>
  fromISO(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

export const formatMonth = (month: string) =>
  fromISO(`${month}-01`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

export function relativeLabel(iso: string): string | null {
  const today = todayISO();
  if (iso === today) return "Today";
  if (iso === addDays(today, -1)) return "Yesterday";
  if (iso === addDays(today, 1)) return "Tomorrow";
  return null;
}
