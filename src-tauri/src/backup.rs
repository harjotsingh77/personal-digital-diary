//! Backup export / import, in two formats.
//!
//! **Encrypted** (`.diarybackup`): everything, including videos, streamed
//! through a key derived from a backup password. Its layout is a magic number,
//! the Argon2 salt, then one sealed stream of records (see `Record`).
//!
//! **Plain JSON**: every entry (decrypted) plus its photos and voice notes as
//! base64. It is deliberately readable so it can never be locked away by a lost
//! password or a future app version, which also means it must be kept somewhere
//! safe; the UI warns about this before exporting. It leaves videos out: they
//! can be any size, and a JSON file has to fit in memory.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;

use crate::crypto::{self, Key};
use crate::sealed::{SealedReader, SealedWriter};
use crate::video::{self, VideoWriter};
use crate::entries::{self, EntryPayload};
use crate::error::{AppError, AppResult};
use crate::attachments::{self, Kind};

const FORMAT: &str = "personal-digital-diary-backup";
/// v2 added voice notes and v3 video notes; older apps would silently drop
/// them, so they refuse newer versions.
const VERSION: u32 = 3;

const MAGIC: &[u8; 8] = b"DIARYBK1";
const SALT_LEN: usize = 16;
const SEALED_DOMAIN: &str = "backup";
/// Buffer for copying videos, which are streamed rather than loaded.
const COPY_CHUNK: usize = 256 * 1024;

/// Record tags in a sealed stream. Each is followed by a 32-char id (except
/// the manifest and the end marker) and a little-endian u64 length, then data.
mod record {
    pub const MANIFEST: u8 = b'M';
    pub const PHOTO: u8 = b'P';
    pub const VOICE: u8 = b'V';
    pub const VIDEO: u8 = b'F';
    pub const END: u8 = b'E';
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Backup {
    format: String,
    version: u32,
    exported_at: i64,
    entries: Vec<BackupEntry>,
    /// photo id → base64 image bytes
    #[serde(default)]
    photos: BTreeMap<String, String>,
    /// voice note id → base64 audio bytes
    #[serde(default)]
    voice: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupEntry {
    date: String,
    created_at: i64,
    updated_at: i64,
    #[serde(flatten)]
    payload: EntryPayload,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    /// Entries skipped because the diary already had a newer version.
    pub skipped: usize,
}

pub fn export(conn: &Connection, key: &Key, data_dir: &Path, now: i64) -> AppResult<Vec<u8>> {
    let mut out = Backup { format: FORMAT.into(), version: VERSION, exported_at: now, entries: vec![], photos: BTreeMap::new(), voice: BTreeMap::new() };
    // Oldest first reads more naturally in a backup file.
    for (date, created_at, updated_at, payload) in entries::list_payloads(conn, key, None)?.into_iter().rev() {
        for id in &payload.photos {
            // A missing photo file shouldn't block the whole backup.
            if let Ok(bytes) = attachments::get(data_dir, key, Kind::Photo, id) {
                out.photos.insert(id.clone(), B64.encode(bytes));
            }
        }
        for note in &payload.voice_notes {
            if let Ok(bytes) = attachments::get(data_dir, key, Kind::Voice, &note.id) {
                out.voice.insert(note.id.clone(), B64.encode(bytes));
            }
        }
        out.entries.push(BackupEntry { date, created_at, updated_at, payload });
    }
    serde_json::to_vec_pretty(&out).map_err(|e| AppError::Internal(e.to_string()))
}

/// Merge a backup into the diary. For a day that exists on both sides, the
/// more recently edited version wins, so importing is always safe to repeat.
pub fn import(conn: &mut Connection, key: &Key, data_dir: &Path, json: &[u8]) -> AppResult<ImportResult> {
    let backup: Backup = serde_json::from_slice(json)
        .map_err(|e| AppError::Invalid(format!("This doesn't look like a diary backup ({e})")))?;
    if backup.format != FORMAT {
        return Err(AppError::Invalid("This doesn't look like a diary backup".into()));
    }
    if backup.version > VERSION {
        return Err(AppError::Invalid("This backup was made by a newer version of the app".into()));
    }
    for e in &backup.entries {
        entries::validate_date(&e.date)?;
    }

    // Write attachment files first so entries never reference missing ones.
    for (id, b64) in &backup.photos {
        let bytes = B64.decode(b64).map_err(|_| AppError::Invalid("Backup contains a damaged photo".into()))?;
        attachments::put(data_dir, key, Kind::Photo, id, &bytes)?;
    }
    for (id, b64) in &backup.voice {
        let bytes = B64.decode(b64).map_err(|_| AppError::Invalid("Backup contains a damaged voice note".into()))?;
        attachments::put(data_dir, key, Kind::Voice, id, &bytes)?;
    }

    merge_entries(conn, key, backup.entries)
}

fn merge_entries(conn: &mut Connection, key: &Key, incoming: Vec<BackupEntry>) -> AppResult<ImportResult> {
    let tx = conn.transaction()?;
    let mut result = ImportResult { imported: 0, skipped: 0 };
    for e in incoming {
        let newer_exists = entries::updated_at(&tx, &e.date)?.is_some_and(|existing| existing >= e.updated_at);
        if newer_exists {
            result.skipped += 1;
            continue;
        }
        entries::put_raw(&tx, key, &e.date, e.created_at, e.updated_at, &e.payload)?;
        result.imported += 1;
    }
    tx.commit()?;
    Ok(result)
}

fn io(e: std::io::Error) -> AppError {
    AppError::Internal(e.to_string())
}

/// Does this file start like an encrypted backup?
pub fn is_sealed(head: &[u8]) -> bool {
    head.starts_with(MAGIC)
}

/// The entries of a backup, gathered up front so the database isn't held
/// while a long backup is written.
pub struct Snapshot(Vec<BackupEntry>);

pub fn snapshot(conn: &Connection, key: &Key) -> AppResult<Snapshot> {
    Ok(Snapshot(
        entries::list_payloads(conn, key, None)?
            .into_iter()
            .rev()
            .map(|(date, created_at, updated_at, payload)| BackupEntry { date, created_at, updated_at, payload })
            .collect(),
    ))
}

/// Write an encrypted backup under `backup_key`, derived from `salt`.
pub fn write_sealed(
    out: impl Write,
    snapshot: &Snapshot,
    key: &Key,
    data_dir: &Path,
    backup_key: &Key,
    salt: &[u8],
    include_videos: bool,
    now: i64,
) -> AppResult<()> {
    let mut out = out;
    out.write_all(MAGIC).map_err(io)?;
    out.write_all(salt).map_err(io)?;
    let mut w = SealedWriter::new(out, backup_key.clone(), SEALED_DOMAIN.into());

    let manifest = Backup {
        format: FORMAT.into(),
        version: VERSION,
        exported_at: now,
        entries: vec![],
        photos: BTreeMap::new(),
        voice: BTreeMap::new(),
    };
    let mut value = serde_json::to_value(&manifest).map_err(|e| AppError::Internal(e.to_string()))?;
    value["entries"] = serde_json::to_value(&snapshot.0).map_err(|e| AppError::Internal(e.to_string()))?;
    let json = serde_json::to_vec(&value).map_err(|e| AppError::Internal(e.to_string()))?;
    w.write_all(&[record::MANIFEST]).map_err(io)?;
    w.write_all(&(json.len() as u64).to_le_bytes()).map_err(io)?;
    w.write_all(&json).map_err(io)?;

    for e in &snapshot.0 {
        // A missing file shouldn't block the whole backup.
        for id in &e.payload.photos {
            if let Ok(bytes) = attachments::get(data_dir, key, Kind::Photo, id) {
                write_blob(&mut w, record::PHOTO, id, &bytes)?;
            }
        }
        for note in &e.payload.voice_notes {
            if let Ok(bytes) = attachments::get(data_dir, key, Kind::Voice, &note.id) {
                write_blob(&mut w, record::VOICE, &note.id, &bytes)?;
            }
        }
        if include_videos {
            for note in &e.payload.video_notes {
                if video::exists(data_dir, &note.id) {
                    write_video(&mut w, data_dir, key, &note.id)?;
                }
            }
        }
    }
    w.write_all(&[record::END]).map_err(io)?;
    w.finish()?;
    Ok(())
}

fn write_header<W: Write>(w: &mut W, tag: u8, id: &str, len: u64) -> AppResult<()> {
    attachments::validate_id(id)?;
    w.write_all(&[tag]).map_err(io)?;
    w.write_all(id.as_bytes()).map_err(io)?;
    w.write_all(&len.to_le_bytes()).map_err(io)
}

fn write_blob<W: Write>(w: &mut W, tag: u8, id: &str, bytes: &[u8]) -> AppResult<()> {
    write_header(w, tag, id, bytes.len() as u64)?;
    w.write_all(bytes).map_err(io)
}

fn write_video<W: Write>(w: &mut W, data_dir: &Path, key: &Key, id: &str) -> AppResult<()> {
    let size = video::size(data_dir, id)?;
    write_header(w, record::VIDEO, id, size)?;
    let mut pos = 0;
    while pos < size {
        let chunk = video::read_range(data_dir, key, id, pos, pos + crate::sealed::FRAME as u64)?;
        if chunk.is_empty() {
            return Err(AppError::Internal("Video ended early".into()));
        }
        w.write_all(&chunk).map_err(io)?;
        pos += chunk.len() as u64;
    }
    Ok(())
}

/// Read the salt from a sealed backup and derive its key from `password`.
pub fn open_sealed<R: Read>(mut input: R, password: &str) -> AppResult<SealedReader<R>> {
    let mut magic = [0u8; 8];
    let mut salt = [0u8; SALT_LEN];
    let bad = |_| AppError::Invalid("This doesn't look like a diary backup".into());
    input.read_exact(&mut magic).map_err(bad)?;
    if &magic != MAGIC {
        return Err(AppError::Invalid("This doesn't look like a diary backup".into()));
    }
    input.read_exact(&mut salt).map_err(bad)?;
    let backup_key = crypto::derive_kek(password, &salt)?;
    SealedReader::new(input, backup_key, SEALED_DOMAIN.into()).map_err(io)
}

/// Merge an encrypted backup. Attachments are written as they arrive and
/// entries last, so entries never reference missing files.
pub fn import_sealed<R: Read>(conn: &std::sync::Mutex<Connection>, key: &Key, data_dir: &Path, mut r: SealedReader<R>) -> AppResult<ImportResult> {
    let damaged = |_: std::io::Error| AppError::Invalid("Wrong backup password, or the file is damaged".into());
    let mut tag = [0u8; 1];
    r.read_exact(&mut tag).map_err(damaged)?;
    if tag[0] != record::MANIFEST {
        return Err(AppError::Invalid("Wrong backup password, or the file is damaged".into()));
    }
    let len = read_u64(&mut r).map_err(damaged)?;
    let mut json = vec![];
    r.by_ref().take(len).read_to_end(&mut json).map_err(damaged)?;
    let backup: Backup = serde_json::from_slice(&json)
        .map_err(|e| AppError::Invalid(format!("This doesn't look like a diary backup ({e})")))?;
    if backup.version > VERSION {
        return Err(AppError::Invalid("This backup was made by a newer version of the app".into()));
    }
    for e in &backup.entries {
        entries::validate_date(&e.date)?;
    }

    loop {
        r.read_exact(&mut tag).map_err(damaged)?;
        if tag[0] == record::END {
            break;
        }
        let mut id = [0u8; 32];
        r.read_exact(&mut id).map_err(damaged)?;
        let id = String::from_utf8_lossy(&id).into_owned();
        attachments::validate_id(&id)?;
        let len = read_u64(&mut r).map_err(damaged)?;
        match tag[0] {
            record::PHOTO | record::VOICE => {
                let mut bytes = vec![];
                r.by_ref().take(len).read_to_end(&mut bytes).map_err(damaged)?;
                let kind = if tag[0] == record::PHOTO { Kind::Photo } else { Kind::Voice };
                attachments::put(data_dir, key, kind, &id, &bytes)?;
            }
            record::VIDEO => {
                let mut w = VideoWriter::with_id(data_dir, key, id)?;
                let mut left = len;
                let mut buf = vec![0u8; COPY_CHUNK];
                while left > 0 {
                    let want = left.min(COPY_CHUNK as u64) as usize;
                    if let Err(e) = r.read_exact(&mut buf[..want]) {
                        w.cancel();
                        return Err(damaged(e));
                    }
                    w.append(&buf[..want])?;
                    left -= want as u64;
                }
                w.finish()?;
            }
            _ => return Err(AppError::Invalid("Wrong backup password, or the file is damaged".into())),
        }
    }
    merge_entries(&mut conn.lock().unwrap(), key, backup.entries)
}

fn read_u64<R: Read>(r: &mut R) -> std::io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn sealed_backup_roundtrip_with_video() {
        let tmp = std::env::temp_dir().join(format!("diary-sealed-backup-{}", std::process::id()));
        let conn = db::init(Connection::open_in_memory().unwrap()).unwrap();
        let key = crypto::random_key();
        let photo = attachments::add(&tmp, &key, Kind::Photo, b"img").unwrap();
        let voice = attachments::add(&tmp, &key, Kind::Voice, b"audio").unwrap();
        let clip = vec![3u8; crate::sealed::FRAME + 9];
        let mut w = VideoWriter::begin(&tmp, &key).unwrap();
        w.append(&clip).unwrap();
        let vid = w.finish().unwrap();
        let p = EntryPayload {
            text: "secret words".into(),
            photos: vec![photo.clone()],
            voice_notes: vec![entries::VoiceNote { id: voice.clone(), ..Default::default() }],
            video_notes: vec![entries::VideoNote { id: vid.clone(), mime: "video/mp4".into(), ..Default::default() }],
            ..Default::default()
        };
        entries::save(&conn, &key, "2026-10-01", &p).unwrap();

        let salt = crypto::random_bytes::<SALT_LEN>();
        let backup_key = crypto::derive_kek("backup pw", &salt).unwrap();
        let snap = snapshot(&conn, &key).unwrap();
        let mut file = Vec::new();
        write_sealed(&mut file, &snap, &key, &tmp, &backup_key, &salt, true, 1).unwrap();
        assert!(is_sealed(&file));
        assert!(!String::from_utf8_lossy(&file).contains("secret words"));

        assert!(open_sealed(&file[..], "wrong").is_err() || {
            let conn2 = std::sync::Mutex::new(db::init(Connection::open_in_memory().unwrap()).unwrap());
            import_sealed(&conn2, &key, &tmp, open_sealed(&file[..], "wrong").unwrap()).is_err()
        });

        let conn2 = std::sync::Mutex::new(db::init(Connection::open_in_memory().unwrap()).unwrap());
        let key2 = crypto::random_key();
        let tmp2 = tmp.join("other");
        let r = import_sealed(&conn2, &key2, &tmp2, open_sealed(&file[..], "backup pw").unwrap()).unwrap();
        assert_eq!((r.imported, r.skipped), (1, 0));
        assert_eq!(attachments::get(&tmp2, &key2, Kind::Photo, &photo).unwrap(), b"img");
        assert_eq!(attachments::get(&tmp2, &key2, Kind::Voice, &voice).unwrap(), b"audio");
        assert_eq!(video::read_range(&tmp2, &key2, &vid, 0, u64::MAX).unwrap(), clip);

        // Without videos, the entry survives and the file is simply absent.
        let tmp3 = tmp.join("third");
        let mut file = Vec::new();
        write_sealed(&mut file, &snap, &key, &tmp, &backup_key, &salt, false, 1).unwrap();
        let conn3 = std::sync::Mutex::new(db::init(Connection::open_in_memory().unwrap()).unwrap());
        import_sealed(&conn3, &key2, &tmp3, open_sealed(&file[..], "backup pw").unwrap()).unwrap();
        assert!(!video::exists(&tmp3, &vid));
        assert_eq!(entries::get(&conn3.lock().unwrap(), &key2, "2026-10-01").unwrap().unwrap().payload.video_notes.len(), 1);
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn truncated_sealed_backup_is_rejected() {
        let tmp = std::env::temp_dir().join(format!("diary-sealed-trunc-{}", std::process::id()));
        let conn = db::init(Connection::open_in_memory().unwrap()).unwrap();
        let key = crypto::random_key();
        entries::save(&conn, &key, "2026-10-01", &EntryPayload { text: "x".into(), ..Default::default() }).unwrap();
        let salt = crypto::random_bytes::<SALT_LEN>();
        let backup_key = crypto::derive_kek("pw", &salt).unwrap();
        let mut file = Vec::new();
        write_sealed(&mut file, &snapshot(&conn, &key).unwrap(), &key, &tmp, &backup_key, &salt, true, 1).unwrap();
        file.truncate(file.len() - 3);
        let conn2 = std::sync::Mutex::new(db::init(Connection::open_in_memory().unwrap()).unwrap());
        let result = open_sealed(&file[..], "pw").and_then(|r| import_sealed(&conn2, &key, &tmp, r));
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn export_then_import_into_fresh_diary() {
        let tmp = std::env::temp_dir().join(format!("diary-backup-test-{}", std::process::id()));
        let conn = db::init(Connection::open_in_memory().unwrap()).unwrap();
        let key = crypto::random_key();
        let photo = attachments::add(&tmp, &key, Kind::Photo, b"img").unwrap();
        let voice = attachments::add(&tmp, &key, Kind::Voice, b"audio").unwrap();
        let note = entries::VoiceNote { id: voice.clone(), mime: "audio/mp4".into(), duration_ms: 1500, recorded_at: 0, peaks: vec![1, 2], ..Default::default() };
        let p = EntryPayload { title: "T".into(), text: "hello".into(), tags: vec!["x".into()], photos: vec![photo.clone()], voice_notes: vec![note], mood: Some("good".into()), ..Default::default() };
        entries::save(&conn, &key, "2026-10-01", &p).unwrap();
        let json = export(&conn, &key, &tmp, 1).unwrap();

        // Import into a brand-new diary with a different key.
        let mut conn2 = db::init(Connection::open_in_memory().unwrap()).unwrap();
        let key2 = crypto::random_key();
        let tmp2 = tmp.join("other");
        let r = import(&mut conn2, &key2, &tmp2, &json).unwrap();
        assert_eq!((r.imported, r.skipped), (1, 0));
        let e = entries::get(&conn2, &key2, "2026-10-01").unwrap().unwrap();
        assert_eq!((e.payload.title.as_str(), e.payload.mood.as_deref()), ("T", Some("good")));
        assert_eq!(attachments::get(&tmp2, &key2, Kind::Photo, &photo).unwrap(), b"img");
        assert_eq!(attachments::get(&tmp2, &key2, Kind::Voice, &voice).unwrap(), b"audio");
        assert_eq!(e.payload.voice_notes[0].duration_ms, 1500);

        // Re-importing the same file changes nothing.
        let r = import(&mut conn2, &key2, &tmp2, &json).unwrap();
        assert_eq!((r.imported, r.skipped), (0, 1));
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn rejects_foreign_json() {
        let mut conn = db::init(Connection::open_in_memory().unwrap()).unwrap();
        let key = crypto::random_key();
        assert!(import(&mut conn, &key, Path::new("/tmp"), br#"{"hello":1}"#).is_err());
    }
}
