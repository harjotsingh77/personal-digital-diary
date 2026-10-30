// The mood scale. `id` is what gets stored (encrypted) with an entry;
// `score` (1–5) drives the mood chart.
export interface Mood {
  id: string;
  emoji: string;
  label: string;
  score: number;
}

export const MOODS: Mood[] = [
  { id: "great", emoji: "😄", label: "Great", score: 5 },
  { id: "good", emoji: "🙂", label: "Good", score: 4 },
  { id: "okay", emoji: "😐", label: "Okay", score: 3 },
  { id: "low", emoji: "😔", label: "Low", score: 2 },
  { id: "awful", emoji: "😢", label: "Awful", score: 1 },
];

const byId = new Map(MOODS.map((m) => [m.id, m]));
export const moodById = (id: string | null | undefined) => (id ? byId.get(id) : undefined);
