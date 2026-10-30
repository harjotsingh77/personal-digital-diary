//! Diary entries: encrypt-on-write / decrypt-on-read over the `entries` table.
//!
//! Plaintext never touches the disk. Each row's payload is the JSON of
//! [`EntryPayload`], encrypted with the data key and bound (via AES-GCM
//! associated data) to the row's date.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::crypto::{self, Key};
use crate::error::{AppError, AppResult};

/// Everything secret about an entry. New fields (mood, tags, photos…) are
/// added here with `#[serde(default)]` so older entries still decrypt.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryPayload {
    pub title: String,
    /// Rich text as HTML produced by the editor.
    pub content: String,
    /// Plain-text version, used for previews, search and word counts.
    pub text: String,
    /// Mood id (e.g. "great", "okay"); see `src/lib/moods.ts`.
    pub mood: Option<String>,
    /// Lower-case tags without a leading '#'.
    pub tags: Vec<String>,
    /// Ids of encrypted photo files attached to this entry, in order.
    pub photos: Vec<String>,
    /// Recorded voice notes, oldest first.
    pub voice_notes: Vec<VoiceNote>,
    /// Recorded video notes, in the order they appear on the page.
    pub video_notes: Vec<VideoNote>,
    /// Starred, so the day is easy to find again.
    pub favourite: bool,
}

/// A voice note's audio lives in an encrypted file; this is what the entry
/// keeps about it so the player can draw itself without decoding the audio.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceNote {
    pub id: String,
    /// Audio container the recording was made in, e.g. "audio/mp4".
    pub mime: String,
    pub duration_ms: u64,
    /// When recording started (unix millis), shown next to the player.
    pub recorded_at: i64,
    /// Loudness samples (0–100) for drawing the waveform.
    pub peaks: Vec<u8>,
    /// Text of the note, once it has been transcribed on this Mac.
    pub transcript: String,
}

/// A video's frames live in a sealed file; this is what the entry keeps about it.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoNote {
    pub id: String,
    /// Container the recording was made in, e.g. "video/mp4".
    pub mime: String,
    pub duration_ms: u64,
    pub recorded_at: i64,
    /// Small JPEG (data URL) shown before the video is played.
    pub poster: String,
}

impl EntryPayload {
    pub fn is_empty(&self) -> bool {
        self.title.trim().is_empty()
            && self.text.trim().is_empty()
            && self.mood.is_none()
            && self.photos.is_empty()
            && self.voice_notes.is_empty()
            && self.video_notes.is_empty()
    }

    /// Trim / lower-case / de-duplicate tags.
    fn normalise(&mut self) {
        let mut seen = std::collections::HashSet::new();
        self.tags = self
            .tags
            .iter()
            .map(|t| t.trim().trim_start_matches('#').trim().to_lowercase())
            .filter(|t| !t.is_empty() && t.len() <= 40 && seen.insert(t.clone()))
            .collect();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub date: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(flatten)]
    pub payload: EntryPayload,
}

/// Lightweight view of an entry for the calendar, timeline and search.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySummary {
    pub date: String,
    pub title: String,
    pub preview: String,
    pub word_count: usize,
    pub mood: Option<String>,
    pub tags: Vec<String>,
    pub photo_count: usize,
    pub voice_count: usize,
    pub video_count: usize,
    pub favourite: bool,
    /// First photo, used as a thumbnail in the timeline.
    pub cover_photo: Option<String>,
    pub updated_at: i64,
}

const PREVIEW_CHARS: usize = 220;

fn preview_of(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max).collect();
    // Prefer to end on a word boundary.
    let cut = cut.rsplit_once(' ').map(|(a, _)| a.to_string()).unwrap_or(cut);
    format!("{cut}…")
}

impl EntrySummary {
    pub fn from(date: String, updated_at: i64, p: EntryPayload) -> Self {
        EntrySummary {
            preview: preview_of(&p.text, PREVIEW_CHARS),
            word_count: p.text.split_whitespace().count(),
            photo_count: p.photos.len(),
            voice_count: p.voice_notes.len(),
            video_count: p.video_notes.len(),
            favourite: p.favourite,
            cover_photo: p.photos.first().cloned(),
            date,
            title: p.title,
            mood: p.mood,
            tags: p.tags,
            updated_at,
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Accept only `YYYY-MM-DD` with a plausible month/day.
pub fn validate_date(date: &str) -> AppResult<()> {
    let b = date.as_bytes();
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
        && matches!(date[5..7].parse::<u8>(), Ok(1..=12))
        && matches!(date[8..10].parse::<u8>(), Ok(1..=31));
    if ok { Ok(()) } else { Err(AppError::Invalid(format!("Invalid date: {date}"))) }
}

fn aad(date: &str) -> Vec<u8> {
    format!("entry:{date}").into_bytes()
}

fn seal(key: &Key, date: &str, payload: &EntryPayload) -> AppResult<Vec<u8>> {
    let json = zeroize::Zeroizing::new(
        serde_json::to_vec(payload).map_err(|e| AppError::Internal(e.to_string()))?,
    );
    crypto::encrypt_aad(key, &json, &aad(date))
}

fn open_payload(key: &Key, date: &str, blob: &[u8]) -> AppResult<EntryPayload> {
    let json = crypto::decrypt_aad(key, blob, &aad(date))?;
    serde_json::from_slice(&json).map_err(|e| AppError::Internal(e.to_string()))
}

pub fn get(conn: &Connection, key: &Key, date: &str) -> AppResult<Option<Entry>> {
    validate_date(date)?;
    let row = conn
        .query_row(
            "SELECT created_at, updated_at, payload FROM entries WHERE entry_date = ?1",
            [date],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, Vec<u8>>(2)?)),
        )
        .optional()?;
    row.map(|(created_at, updated_at, blob)| {
        Ok(Entry {
            date: date.to_string(),
            created_at,
            updated_at,
            payload: open_payload(key, date, &blob)?,
        })
    })
    .transpose()
}

/// Insert or update the entry for `date`. An entry with nothing in it
/// (no title, text, mood, photos or voice notes) is deleted instead, so empty days don't show up in the calendar or streak.
pub fn save(conn: &Connection, key: &Key, date: &str, payload: &EntryPayload) -> AppResult<Option<Entry>> {
    validate_date(date)?;
    let mut payload = payload.clone();
    payload.normalise();
    if payload.is_empty() {
        delete(conn, date)?;
        return Ok(None);
    }
    let blob = seal(key, date, &payload)?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO entries (entry_date, created_at, updated_at, payload)
         VALUES (?1, ?2, ?2, ?3)
         ON CONFLICT(entry_date) DO UPDATE SET updated_at = ?2, payload = excluded.payload",
        params![date, now, blob],
    )?;
    get(conn, key, date)
}

/// Decrypt every entry (optionally only one "YYYY-MM" month), newest first.
/// A personal diary is small enough that decrypting in a loop is instant,
/// and it keeps everything except dates encrypted at rest.
pub fn list_payloads(
    conn: &Connection,
    key: &Key,
    month: Option<&str>,
) -> AppResult<Vec<(String, i64, i64, EntryPayload)>> {
    let pattern = match month {
        Some(m) => {
            validate_date(&format!("{m}-01"))?;
            format!("{m}-%")
        }
        None => "%".to_string(),
    };
    let mut stmt = conn.prepare(
        "SELECT entry_date, created_at, updated_at, payload FROM entries
         WHERE entry_date LIKE ?1 ORDER BY entry_date DESC",
    )?;
    let rows = stmt.query_map([pattern], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, Vec<u8>>(3)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (date, created, updated, blob) = row?;
        let payload = open_payload(key, &date, &blob)?;
        out.push((date, created, updated, payload));
    }
    Ok(out)
}

pub fn list(conn: &Connection, key: &Key, month: Option<&str>) -> AppResult<Vec<EntrySummary>> {
    Ok(list_payloads(conn, key, month)?
        .into_iter()
        .map(|(date, _, updated, p)| EntrySummary::from(date, updated, p))
        .collect())
}

/// Every voice note id referenced by any entry.
pub fn voice_note_ids(conn: &Connection, key: &Key) -> AppResult<std::collections::HashSet<String>> {
    Ok(list_payloads(conn, key, None)?
        .into_iter()
        .flat_map(|(_, _, _, p)| p.voice_notes.into_iter().map(|n| n.id))
        .collect())
}

/// Every video note id referenced by any entry.
pub fn video_note_ids(conn: &Connection, key: &Key) -> AppResult<std::collections::HashSet<String>> {
    Ok(list_payloads(conn, key, None)?
        .into_iter()
        .flat_map(|(_, _, _, p)| p.video_notes.into_iter().map(|n| n.id))
        .collect())
}

/// Write an entry with explicit timestamps (used by backup import).
pub fn put_raw(conn: &Connection, key: &Key, date: &str, created_at: i64, updated_at: i64, payload: &EntryPayload) -> AppResult<()> {
    validate_date(date)?;
    let mut payload = payload.clone();
    payload.normalise();
    let blob = seal(key, date, &payload)?;
    conn.execute(
        "INSERT INTO entries (entry_date, created_at, updated_at, payload) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(entry_date) DO UPDATE SET created_at = ?2, updated_at = ?3, payload = excluded.payload",
        params![date, created_at, updated_at, blob],
    )?;
    Ok(())
}

/// `updated_at` of the entry for `date`, if one exists.
pub fn updated_at(conn: &Connection, date: &str) -> AppResult<Option<i64>> {
    Ok(conn
        .query_row("SELECT updated_at FROM entries WHERE entry_date = ?1", [date], |r| r.get(0))
        .optional()?)
}

pub fn delete(conn: &Connection, date: &str) -> AppResult<()> {
    validate_date(date)?;
    conn.execute("DELETE FROM entries WHERE entry_date = ?1", [date])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn setup() -> (Connection, Key) {
        (db::init(Connection::open_in_memory().unwrap()).unwrap(), crypto::random_key())
    }

    fn payload(title: &str, text: &str) -> EntryPayload {
        EntryPayload {
            title: title.into(),
            content: format!("<p>{text}</p>"),
            text: text.into(),
            ..Default::default()
        }
    }

    #[test]
    fn save_get_update() {
        let (conn, key) = setup();
        assert!(get(&conn, &key, "2026-10-14").unwrap().is_none());

        let e = save(&conn, &key, "2026-10-14", &payload("Hi", "first")).unwrap().unwrap();
        assert_eq!(e.payload.text, "first");

        save(&conn, &key, "2026-10-14", &payload("Hi", "second")).unwrap();
        let e = get(&conn, &key, "2026-10-14").unwrap().unwrap();
        assert_eq!(e.payload.text, "second");
        assert!(e.updated_at >= e.created_at);
    }

    #[test]
    fn stored_payload_is_not_plaintext() {
        let (conn, key) = setup();
        save(&conn, &key, "2026-10-14", &payload("Secret title", "very secret words")).unwrap();
        let blob: Vec<u8> = conn
            .query_row("SELECT payload FROM entries", [], |r| r.get(0))
            .unwrap();
        let hay = String::from_utf8_lossy(&blob);
        assert!(!hay.contains("secret") && !hay.contains("Secret"));
    }

    #[test]
    fn wrong_key_or_swapped_row_fails() {
        let (conn, key) = setup();
        save(&conn, &key, "2026-10-14", &payload("a", "a")).unwrap();
        assert!(get(&conn, &crypto::random_key(), "2026-10-14").is_err());

        // Moving a ciphertext to another date must not decrypt.
        conn.execute("UPDATE entries SET entry_date = '2026-10-15'", []).unwrap();
        assert!(get(&conn, &key, "2026-10-15").is_err());
    }

    #[test]
    fn empty_entry_is_deleted() {
        let (conn, key) = setup();
        save(&conn, &key, "2026-10-14", &payload("t", "x")).unwrap();
        assert!(save(&conn, &key, "2026-10-14", &payload(" ", "")).unwrap().is_none());
        assert!(get(&conn, &key, "2026-10-14").unwrap().is_none());
    }

    #[test]
    fn tags_are_normalised_and_old_payloads_decode() {
        let (conn, key) = setup();
        let mut p = payload("t", "x");
        p.tags = vec!["#Work".into(), "work".into(), " Family ".into(), "".into()];
        let e = save(&conn, &key, "2026-10-14", &p).unwrap().unwrap();
        assert_eq!(e.payload.tags, vec!["work", "family"]);

        // A Phase-2 payload without the newer fields still deserialises.
        let old: EntryPayload = serde_json::from_str(r#"{"title":"a","content":"","text":"b"}"#).unwrap();
        assert!(old.tags.is_empty() && old.mood.is_none() && old.voice_notes.is_empty());
    }

    #[test]
    fn voice_note_alone_keeps_entry() {
        let (conn, key) = setup();
        let mut p = payload("", "");
        p.voice_notes = vec![VoiceNote { id: "a".repeat(32), mime: "audio/mp4".into(), duration_ms: 4200, recorded_at: 0, peaks: vec![10, 80], ..Default::default() }];
        let e = save(&conn, &key, "2026-10-14", &p).unwrap().unwrap();
        assert_eq!(e.payload.voice_notes[0].duration_ms, 4200);
        assert_eq!(list(&conn, &key, None).unwrap()[0].voice_count, 1);
    }

    #[test]
    fn video_note_alone_keeps_entry_and_favourite_alone_does_not() {
        let (conn, key) = setup();
        let mut p = payload("", "");
        p.favourite = true;
        assert!(save(&conn, &key, "2026-10-14", &p).unwrap().is_none());
        p.video_notes = vec![VideoNote { id: "b".repeat(32), mime: "video/mp4".into(), ..Default::default() }];
        let e = save(&conn, &key, "2026-10-14", &p).unwrap().unwrap();
        assert!(e.payload.favourite);
        let summary = &list(&conn, &key, None).unwrap()[0];
        assert_eq!((summary.video_count, summary.favourite), (1, true));
        assert_eq!(video_note_ids(&conn, &key).unwrap().len(), 1);
    }

    #[test]
    fn list_is_newest_first_and_filters_by_month() {
        let (conn, key) = setup();
        for d in ["2026-09-30", "2026-10-02", "2026-10-14"] {
            save(&conn, &key, d, &payload(d, "some words here")).unwrap();
        }
        let all = list(&conn, &key, None).unwrap();
        assert_eq!(all.iter().map(|e| e.date.as_str()).collect::<Vec<_>>(), ["2026-10-14", "2026-10-02", "2026-09-30"]);
        assert_eq!(all[0].word_count, 3);
        assert_eq!(list(&conn, &key, Some("2026-10")).unwrap().len(), 2);
        assert!(list(&conn, &key, Some("2026-1%")).is_err());
    }

    #[test]
    fn preview_truncates_on_word_boundary() {
        assert_eq!(preview_of("a  b\n c", 10), "a b c");
        assert_eq!(preview_of("hello wonderful world", 12), "hello…");
    }

    #[test]
    fn rejects_bad_dates() {
        for bad in ["2026-13-01", "2026-1-01", "20261014", "2026-10-14'--", ""] {
            assert!(validate_date(bad).is_err(), "{bad}");
        }
        assert!(validate_date("2026-02-28").is_ok());
    }
}
