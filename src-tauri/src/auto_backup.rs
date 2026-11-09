//! Automatic encrypted backups to a folder of the user's choosing.
//!
//! The backup password is stretched once when this is turned on; only the
//! resulting key is kept, encrypted under the data key, so backups can run
//! unattended but only while the diary is unlocked.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::backup::{self, Snapshot};
use crate::crypto::{self, Key};
use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const META_KEY: &str = "auto_backup";
const AAD: &[u8] = b"auto-backup";
const PREFIX: &str = "diary-auto-";
const EXTENSION: &str = ".diarybackup";
/// Backups kept in the folder; older ones are removed after a success.
const KEEP: usize = 3;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    folder: PathBuf,
    every_days: u32,
    include_videos: bool,
    salt: Vec<u8>,
    backup_key: Vec<u8>,
    /// Day of the last successful backup, `YYYY-MM-DD`.
    last_run: Option<String>,
    last_error: Option<String>,
}

/// What the Settings screen sees: never the key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupInfo {
    folder: String,
    every_days: u32,
    include_videos: bool,
    last_run: Option<String>,
    last_error: Option<String>,
    pub running: bool,
}

pub fn new_config(folder: PathBuf, password: &str, every_days: u32, include_videos: bool) -> AppResult<Config> {
    let salt = crypto::random_bytes::<16>();
    let backup_key = crypto::derive_kek(password, &salt)?;
    Ok(Config {
        folder,
        every_days: every_days.max(1),
        include_videos,
        salt: salt.to_vec(),
        backup_key: backup_key.to_vec(),
        last_run: None,
        last_error: None,
    })
}

pub fn save(conn: &Connection, key: &Key, config: &Config) -> AppResult<()> {
    let json = Zeroizing::new(serde_json::to_vec(config).map_err(|e| AppError::Internal(e.to_string()))?);
    db::set_meta(conn, META_KEY, &crypto::encrypt_aad(key, &json, AAD)?)
}

fn load(conn: &Connection, key: &Key) -> AppResult<Option<Config>> {
    let Some(blob) = db::get_meta(conn, META_KEY)? else { return Ok(None) };
    let json = crypto::decrypt_aad(key, &blob, AAD)?;
    serde_json::from_slice(&json).map(Some).map_err(|e| AppError::Internal(e.to_string()))
}

pub fn remove(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [META_KEY])?;
    Ok(())
}

pub fn info(conn: &Connection, key: &Key) -> AppResult<Option<AutoBackupInfo>> {
    Ok(load(conn, key)?.map(|c| AutoBackupInfo {
        folder: c.folder.display().to_string(),
        every_days: c.every_days,
        include_videos: c.include_videos,
        last_run: c.last_run,
        last_error: c.last_error,
        running: false,
    }))
}

fn day_number(date: &str) -> i64 {
    crate::stats::day_number(date)
}

fn is_due(config: &Config, today: &str) -> bool {
    config.last_run.as_deref().is_none_or(|last| day_number(today) - day_number(last) >= config.every_days as i64)
}

/// Write a sealed backup to `path` via a temp name, so a failure part-way
/// (a full disk, a removed drive) never leaves something that looks complete.
pub fn write_file(
    path: &Path,
    snapshot: &Snapshot,
    key: &Key,
    data_dir: &Path,
    backup_key: &Key,
    salt: &[u8],
    include_videos: bool,
) -> AppResult<()> {
    let tmp = path.with_extension("partial");
    let io = |e: std::io::Error| AppError::Internal(e.to_string());
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let result = File::create(&tmp).map_err(io).and_then(|file| {
        backup::write_sealed(BufWriter::new(file), snapshot, key, data_dir, backup_key, salt, include_videos, now)
    });
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, path).map_err(io)
}

/// Remove this feature's own older backups, keeping the newest `KEEP`.
/// The date in the name sorts them; other files in the folder are never touched.
fn prune_old(folder: &Path) {
    let Ok(dir) = fs::read_dir(folder) else { return };
    let mut names: Vec<String> = dir
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with(PREFIX) && n.ends_with(EXTENSION))
        .collect();
    names.sort();
    let excess = names.len().saturating_sub(KEEP);
    for name in &names[..excess] {
        let _ = fs::remove_file(folder.join(name));
    }
}

fn run(state: &AppState, key: &Key, mut config: Config, today: &str) -> AppResult<()> {
    let snapshot = backup::snapshot(&state.db.lock().unwrap(), key)?;
    let backup_key: [u8; 32] = config.backup_key[..].try_into().map_err(|_| AppError::Crypto)?;
    let backup_key = Zeroizing::new(backup_key);
    let path = config.folder.join(format!("{PREFIX}{today}{EXTENSION}"));
    let result = write_file(&path, &snapshot, key, &state.data_dir, &backup_key, &config.salt, config.include_videos);
    match &result {
        Ok(()) => {
            prune_old(&config.folder);
            config.last_run = Some(today.to_string());
            config.last_error = None;
        }
        Err(e) => config.last_error = Some(e.to_string()),
    }
    // The user may have turned it off, or set it up again with another folder
    // or password, while this ran. Only record the outcome on the same setup.
    let conn = state.db.lock().unwrap();
    if let Some(mut current) = load(&conn, key)? {
        if current.salt == config.salt && current.folder == config.folder {
            current.last_run = config.last_run;
            current.last_error = config.last_error;
            save(&conn, key, &current)?;
        }
    }
    result
}

/// Start a backup on its own thread if one is due and none is running.
pub fn start_if_due(app: AppHandle, state: &AppState, today: String, force: bool) -> AppResult<bool> {
    let key = state.key()?;
    let Some(config) = load(&state.db.lock().unwrap(), &key)? else { return Ok(false) };
    if !force && !is_due(&config, &today) {
        return Ok(false);
    }
    if state.auto_backup_running.swap(true, Ordering::SeqCst) {
        return Ok(false);
    }
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let _ = run(&state, &key, config, &today);
        state.auto_backup_running.store(false, Ordering::SeqCst);
    });
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entries::{self, EntryPayload};

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("diary-auto-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn config_is_encrypted_and_hides_the_key() {
        let conn = db::init(Connection::open_in_memory().unwrap()).unwrap();
        let key = crypto::random_key();
        let config = new_config("/secret-folder".into(), "pw", 7, true).unwrap();
        save(&conn, &key, &config).unwrap();
        let blob = db::get_meta(&conn, META_KEY).unwrap().unwrap();
        assert!(!String::from_utf8_lossy(&blob).contains("secret-folder"));
        let shown = serde_json::to_string(&info(&conn, &key).unwrap().unwrap()).unwrap();
        assert!(shown.contains("secret-folder") && !shown.contains("backupKey"));
        remove(&conn).unwrap();
        assert!(info(&conn, &key).unwrap().is_none());
    }

    #[test]
    fn due_after_the_chosen_number_of_days() {
        let mut config = new_config("/x".into(), "pw", 7, true).unwrap();
        assert!(is_due(&config, "2026-10-10"));
        config.last_run = Some("2026-10-01".into());
        assert!(!is_due(&config, "2026-10-07"));
        assert!(is_due(&config, "2026-10-08"));
    }

    #[test]
    fn prune_keeps_newest_and_ignores_other_files() {
        let dir = folder("prune");
        for n in ["01", "02", "03", "04", "05"] {
            fs::write(dir.join(format!("{PREFIX}2026-10-{n}{EXTENSION}")), b"x").unwrap();
        }
        fs::write(dir.join("my-holiday.jpg"), b"x").unwrap();
        prune_old(&dir);
        let mut left: Vec<String> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, [
            format!("{PREFIX}2026-10-03{EXTENSION}"),
            format!("{PREFIX}2026-10-04{EXTENSION}"),
            format!("{PREFIX}2026-10-05{EXTENSION}"),
            "my-holiday.jpg".to_string(),
        ]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_write_leaves_nothing_behind() {
        let dir = folder("fail");
        let conn = db::init(Connection::open_in_memory().unwrap()).unwrap();
        let key = crypto::random_key();
        entries::save(&conn, &key, "2026-10-01", &EntryPayload { text: "x".into(), ..Default::default() }).unwrap();
        let snapshot = backup::snapshot(&conn, &key).unwrap();
        let missing = dir.join("no-such-folder").join("b.diarybackup");
        assert!(write_file(&missing, &snapshot, &key, &dir, &crypto::random_key(), &[0; 16], true).is_err());
        let ok = dir.join("b.diarybackup");
        write_file(&ok, &snapshot, &key, &dir, &crypto::random_key(), &[0; 16], true).unwrap();
        assert!(ok.exists() && !ok.with_extension("partial").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
