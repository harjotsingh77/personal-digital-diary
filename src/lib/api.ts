// Typed wrappers around the Rust commands in src-tauri/src/commands.
import { invoke } from "@tauri-apps/api/core";

export interface AuthStatus {
  hasPassword: boolean;
  unlocked: boolean;
  touchId: boolean;
}

/** The encrypted part of an entry (mirrors `EntryPayload` in entries.rs). */
export interface EntryPayload {
  title: string;
  /** Rich text as editor HTML. */
  content: string;
  /** Plain text, for previews / search / word count. */
  text: string;
  mood: string | null;
  tags: string[];
  /** Ids of encrypted photo files, in display order. */
  photos: string[];
  /** Recorded voice notes, oldest first. */
  voiceNotes: VoiceNote[];
  /** Recorded video notes, in page order. */
  videoNotes: VideoNote[];
  /** Bookmarked, so the day is easy to find again. */
  favourite: boolean;
}

/** Mirrors `VoiceNote` in entries.rs; the audio itself is an encrypted file. */
export interface VoiceNote {
  id: string;
  mime: string;
  durationMs: number;
  /** When recording started (unix millis). */
  recordedAt: number;
  /** Loudness samples (0–100) for drawing the waveform. */
  peaks: number[];
  /** The note's words, once transcribed on this Mac. */
  transcript: string;
}

/** Mirrors `VideoNote` in entries.rs; the frames live in a sealed file. */
export interface VideoNote {
  id: string;
  mime: string;
  durationMs: number;
  recordedAt: number;
  /** Small JPEG data URL shown before playing. */
  poster: string;
}

export interface Entry extends EntryPayload {
  date: string;
  createdAt: number;
  updatedAt: number;
}

export interface EntrySummary {
  date: string;
  title: string;
  preview: string;
  wordCount: number;
  mood: string | null;
  tags: string[];
  photoCount: number;
  voiceCount: number;
  videoCount: number;
  favourite: boolean;
  coverPhoto: string | null;
  updatedAt: number;
}

export interface Stats {
  currentStreak: number;
  longestStreak: number;
  totalEntries: number;
  writtenToday: boolean;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
}

/** A picked backup: merged already, or waiting for its password. */
export interface ImportOutcome {
  imported?: number;
  skipped?: number;
  needsPassword: string | null;
}

export interface SearchFilters {
  mood?: string | null;
  from?: string | null;
  to?: string | null;
  favourite?: boolean;
}

export interface PhotoRef {
  id: string;
  date: string;
}

export interface AutoBackupInfo {
  folder: string;
  everyDays: number;
  includeVideos: boolean;
  lastRun: string | null;
  lastError: string | null;
  running: boolean;
}

export const emptyPayload = (): EntryPayload => ({
  title: "",
  content: "",
  text: "",
  mood: null,
  tags: [],
  photos: [],
  voiceNotes: [],
  videoNotes: [],
  favourite: false,
});

export const api = {
  // auth
  authStatus: () => invoke<AuthStatus>("auth_status"),
  setupPassword: (password: string) => invoke<void>("setup_password", { password }),
  unlock: (password: string) => invoke<void>("unlock", { password }),
  lock: () => invoke<void>("lock"),
  changePassword: (current: string, newPassword: string) =>
    invoke<void>("change_password", { current, newPassword }),

  // entries
  getEntry: (date: string) => invoke<Entry | null>("get_entry", { date }),
  /** Returns null when the entry was empty and therefore removed. */
  saveEntry: (date: string, payload: EntryPayload) =>
    invoke<Entry | null>("save_entry", { date, payload }),
  deleteEntry: (date: string) => invoke<void>("delete_entry", { date }),
  /** All entries, or just one "YYYY-MM" month; newest first. */
  listEntries: (month?: string) => invoke<EntrySummary[]>("list_entries", { month: month ?? null }),

  // search, tags, stats
  /** Words must all match; `#tag` terms filter by tag. */
  searchEntries: (query: string, filters?: SearchFilters) =>
    invoke<EntrySummary[]>("search_entries", { query, filters: filters ?? null }),
  onThisDay: (today: string) => invoke<EntrySummary[]>("on_this_day", { today }),
  listPhotos: () => invoke<PhotoRef[]>("list_photos"),
  listTags: () => invoke<TagCount[]>("list_tags"),
  getStats: (today: string) => invoke<Stats>("get_stats", { today }),

  // photos (sent/received as raw bytes, encrypted on disk by Rust)
  addPhoto: (bytes: Uint8Array) => invoke<string>("add_photo", bytes),
  getPhoto: (id: string) => invoke<ArrayBuffer>("get_photo", { id }),
  deletePhoto: (id: string) => invoke<void>("delete_photo", { id }),

  // voice notes (same raw-bytes transport as photos)
  addVoiceNote: (bytes: Uint8Array) => invoke<string>("add_voice_note", bytes),
  getVoiceNote: (id: string) => invoke<ArrayBuffer>("get_voice_note", { id }),
  deleteVoiceNote: (id: string) => invoke<void>("delete_voice_note", { id }),

  transcribeVoiceNote: (id: string, language: string) => invoke<string>("transcribe_voice_note", { id, language }),

  // video notes: streamed to disk chunk by chunk, one recording at a time
  videoBegin: () => invoke<void>("video_begin"),
  videoAppend: (bytes: Uint8Array) => invoke<void>("video_append", bytes),
  videoFinish: () => invoke<string>("video_finish"),
  videoCancel: () => invoke<void>("video_cancel"),
  deleteVideoNote: (id: string) => invoke<void>("delete_video_note", { id }),

  // settings
  /** Opens a save dialog; resolves to the saved path, or null if cancelled. */
  exportBackup: (today: string) => invoke<string | null>("export_backup", { today }),
  /** Opens a save dialog; includes videos unless asked not to. */
  exportEncryptedBackup: (today: string, password: string, includeVideos: boolean) =>
    invoke<string | null>("export_encrypted_backup", { today, password, includeVideos }),
  /** Opens a file picker; null if cancelled. */
  importBackup: () => invoke<ImportOutcome | null>("import_backup"),
  importEncryptedBackup: (path: string, password: string) =>
    invoke<ImportResult>("import_encrypted_backup", { path, password }),
  getAutoBackup: () => invoke<AutoBackupInfo | null>("get_auto_backup"),
  /** Opens a folder picker; false if cancelled. */
  enableAutoBackup: (password: string, everyDays: number, includeVideos: boolean) =>
    invoke<boolean>("enable_auto_backup", { password, everyDays, includeVideos }),
  disableAutoBackup: () => invoke<void>("disable_auto_backup"),
  runAutoBackup: (today: string, force: boolean) => invoke<boolean>("run_auto_backup", { today, force }),
  getReminder: () => invoke<string | null>("get_reminder"),
  setReminder: (time: string | null) => invoke<void>("set_reminder", { time }),
  createRecoveryKey: (password: string) => invoke<string>("create_recovery_key", { password }),
  hasRecoveryKey: () => invoke<boolean>("has_recovery_key"),
  recoverWithKey: (recoveryKey: string, newPassword: string) =>
    invoke<void>("recover_with_key", { recoveryKey, newPassword }),
  printPage: () => invoke<void>("print_page"),
  biometricStatus: () => invoke<{ available: boolean; enabled: boolean }>("biometric_status"),
  enableTouchId: () => invoke<void>("enable_touch_id"),
  disableTouchId: () => invoke<void>("disable_touch_id"),
  unlockWithTouchId: () => invoke<void>("unlock_with_touch_id"),
  dataLocation: () => invoke<string>("data_location"),
};

/** Tauri rejects with the Rust error string; normalise to a message. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}
