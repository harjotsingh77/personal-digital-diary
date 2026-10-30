// DEV-ONLY: an in-memory fake of the Rust backend, used when the frontend is
// opened in a plain browser (`npm run dev`) instead of inside Tauri. It lets
// the UI be developed and checked visually. It never ships in the app —
// main.tsx only imports it when `import.meta.env.DEV` and Tauri is absent.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Entry, EntryPayload, EntrySummary } from "../lib/api";

const entries = new Map<string, Entry>();
let hasPassword = new URLSearchParams(location.search).has("seed");
let unlocked = false;
let touchIdOn = false;

const isEmpty = (p: EntryPayload) =>
  !p.title.trim() && !p.text.trim() && !p.mood && p.photos.length === 0 && !p.voiceNotes?.length && !p.videoNotes?.length;

type Handler = (args: Record<string, unknown>) => unknown;
export const handlers: Record<string, Handler> = {
  auth_status: () => ({ hasPassword, unlocked, touchId: touchIdOn }),
  setup_password: () => { hasPassword = true; unlocked = true; },
  unlock: ({ password }) => {
    if (password !== "password") throw "Incorrect password";
    unlocked = true;
  },
  lock: () => { unlocked = false; },
  change_password: () => {},
  get_entry: ({ date }) => entries.get(date as string) ?? null,
  save_entry: ({ date, payload }) => {
    const d = date as string, p = payload as EntryPayload;
    if (isEmpty(p)) { entries.delete(d); return null; }
    const prev = entries.get(d);
    const now = Date.now();
    const e = { ...p, date: d, createdAt: prev?.createdAt ?? now, updatedAt: now };
    entries.set(d, e);
    return e;
  },
  delete_entry: ({ date }) => { entries.delete(date as string); },
  list_entries: ({ month }) =>
    [...entries.values()]
      .filter((e) => !month || e.date.startsWith(`${month}-`))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(summarise),
};

const photos = new Map<string, ArrayBuffer>();
const voice = new Map<string, ArrayBuffer>();
let recovery = false;
let reminder: string | null = null;
let autoBackup: Record<string, unknown> | null = null;
let videoChunks: Uint8Array[] = [];
const videoUrls = new Map<string, string>();
window.__diaryMockVideoUrl = (id) => videoUrls.get(id);
Object.assign(handlers, {
  search_entries: ({ query, filters }: Record<string, unknown>) => {
    const f = (filters ?? {}) as { mood?: string | null; from?: string | null; to?: string | null; favourite?: boolean };
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const tags = words.filter((w) => w.startsWith("#")).map((w) => w.slice(1));
    const terms = words.filter((w) => !w.startsWith("#"));
    return [...entries.values()]
      .filter((e) => (!f.mood || e.mood === f.mood) && (!f.from || e.date >= f.from) && (!f.to || e.date <= f.to) && (!f.favourite || e.favourite))
      .filter((e) => tags.every((t) => e.tags.includes(t)))
      .filter((e) => terms.every((t) => `${e.title} ${e.text} ${e.tags.join(" ")}`.toLowerCase().includes(t)))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(summarise);
  },
  list_tags: () => {
    const c = new Map<string, number>();
    entries.forEach((e) => e.tags.forEach((t) => c.set(t, (c.get(t) ?? 0) + 1)));
    return [...c].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  },
  get_stats: ({ today }: Record<string, unknown>) => {
    const has = (d: Date) => entries.has(d.toISOString().slice(0, 10));
    const t = new Date(`${today}T00:00:00Z`);
    const writtenToday = has(t);
    let n = 0;
    const c = new Date(t);
    if (!writtenToday) c.setUTCDate(c.getUTCDate() - 1);
    while (has(c)) { n++; c.setUTCDate(c.getUTCDate() - 1); }
    return { currentStreak: n, longestStreak: Math.max(n, 4), totalEntries: entries.size, writtenToday };
  },
  add_photo: (bytes: unknown) => {
    const id = crypto.randomUUID().replace(/-/g, "");
    const u8 = bytes as Uint8Array;
    photos.set(id, u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
    return id;
  },
  get_photo: ({ id }: Record<string, unknown>) => photos.get(String(id)) ?? Promise.reject("not found"),
  delete_photo: ({ id }: Record<string, unknown>) => { photos.delete(String(id)); },
  add_voice_note: (bytes: unknown) => {
    const id = crypto.randomUUID().replace(/-/g, "");
    const u8 = bytes as Uint8Array;
    voice.set(id, u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
    return id;
  },
  get_voice_note: ({ id }: Record<string, unknown>) => voice.get(String(id)) ?? Promise.reject("not found"),
  delete_voice_note: ({ id }: Record<string, unknown>) => { voice.delete(String(id)); },
  export_backup: ({ today }: Record<string, unknown>) => `/Users/you/Documents/diary-backup-${today}.json`,
  import_backup: () => ({ imported: 3, skipped: 1 }),
  biometric_status: () => ({ available: true, enabled: touchIdOn }),
  enable_touch_id: () => { touchIdOn = true; },
  disable_touch_id: () => { touchIdOn = false; },
  unlock_with_touch_id: () => { unlocked = true; },
  has_recovery_key: () => recovery,
  create_recovery_key: () => { recovery = true; return "7K2M-9QXA-4TNB-1RDC-8VHE-3JPG-6WSF-0YZM-5KAB-2CDE-9FGH-1JKM-3N"; },
  recover_with_key: () => { unlocked = true; },
  on_this_day: ({ today }: Record<string, unknown>) => {
    const t = String(today);
    return [...entries.values()]
      .filter((e) => e.date < t && e.date.slice(8) === t.slice(8))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(summarise);
  },
  list_photos: () =>
    [...entries.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .flatMap((e) => e.photos.map((id) => ({ id, date: e.date }))),
  transcribe_voice_note: () => "This is what the recording said, typed out.",
  video_begin: () => { videoChunks = []; },
  video_append: (bytes: unknown) => { videoChunks.push(new Uint8Array(bytes as Uint8Array)); },
  video_finish: () => {
    const id = crypto.randomUUID().replace(/-/g, "");
    videoUrls.set(id, URL.createObjectURL(new Blob(videoChunks as BlobPart[], { type: "video/webm" })));
    videoChunks = [];
    return id;
  },
  video_cancel: () => { videoChunks = []; },
  delete_video_note: () => {},
  export_encrypted_backup: ({ today }: Record<string, unknown>) => `/Users/you/Documents/diary-backup-${today}.diarybackup`,
  import_encrypted_backup: ({ password }: Record<string, unknown>) => {
    if (password !== "password") throw "Wrong backup password, or the file is damaged";
    return { imported: 3, skipped: 1 };
  },
  get_auto_backup: () => autoBackup,
  enable_auto_backup: ({ everyDays, includeVideos }: Record<string, unknown>) => {
    autoBackup = { folder: "/Volumes/Backup/Diary", everyDays, includeVideos, lastRun: null, lastError: null, running: false };
    return true;
  },
  disable_auto_backup: () => { autoBackup = null; },
  run_auto_backup: ({ today, force }: Record<string, unknown>) => {
    if (!autoBackup || !force) return false;
    autoBackup = { ...(autoBackup as object), lastRun: today };
    return true;
  },
  get_reminder: () => reminder,
  set_reminder: ({ time }: Record<string, unknown>) => { reminder = (time as string | null) ?? null; },
  print_page: () => { window.print(); },
  data_location: () => "/Users/you/Library/Application Support/com.harjotsingh.diary",
});

export function summarise(e: Entry): EntrySummary {
  const flat = e.text.split(/\s+/).filter(Boolean);
  return {
    date: e.date, title: e.title, preview: flat.join(" ").slice(0, 220), wordCount: flat.length,
    mood: e.mood, tags: e.tags, photoCount: e.photos.length, voiceCount: e.voiceNotes?.length ?? 0, videoCount: e.videoNotes?.length ?? 0, favourite: !!e.favourite, coverPhoto: e.photos[0] ?? null,
    updatedAt: e.updatedAt,
  };
}

/** `?seed` in the URL fills the mock diary with sample entries. */
function seed() {
  const moods = ["great", "good", "okay", "good", "low", "great", "good", "awful", "okay", "good"];
  const lines = [
    "Long walk by the river this morning. The light on the water was unreal.",
    "Worked on the garden. Tomatoes finally turning red.",
    "Slow day. Read most of a novel and made soup.",
    "Dinner with Maya and Arjun — laughed until midnight.",
    "Tired. Too many meetings, not enough thinking.",
  ];
  const tagSets = [["walks"], ["garden", "home"], ["reading"], ["friends", "food"], ["work"]];
  const today = new Date();
  [1, 2, 3, 5, 6, 9, 12, 15, 16, 20, 26, 30, 33, 40, 41, 365].forEach((ago, i) => {
    const d = new Date(today); d.setDate(d.getDate() - ago);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const text = lines[i % lines.length] + " " + lines[(i + 2) % lines.length];
    entries.set(date, {
      date, title: ["Quiet morning", "Garden notes", "", "Good company", "Long day"][i % 5],
      content: `<p>${text}</p>`, text, mood: moods[i % moods.length], tags: tagSets[i % tagSets.length],
      photos: [], voiceNotes: [], videoNotes: [], favourite: i === 3, createdAt: d.getTime(), updatedAt: d.getTime(),
    });
  });
}
if (hasPassword) seed();

export function installMockBackend(extra: Record<string, Handler> = {}) {
  Object.assign(handlers, extra);
  mockIPC(async (cmd, args) => {
    const h = handlers[cmd];
    if (!h) throw `mock: unknown command ${cmd}`;
    await new Promise((r) => setTimeout(r, 60));
    // Raw binary invokes (photos, voice notes) arrive as the Uint8Array itself.
    return h((args ?? {}) as Record<string, unknown>);
  });
}

export { entries as mockEntries };
