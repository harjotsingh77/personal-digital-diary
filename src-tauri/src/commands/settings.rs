//! Settings: backups, reminder, Touch ID, data location.

use serde::Serialize;
use std::io::Read;
use zeroize::Zeroizing;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::auto_backup::{self, AutoBackupInfo};
use crate::backup::{self, ImportResult};
use crate::reminder;
use crate::crypto;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::{biometric, entries};

const MIN_BACKUP_PASSWORD_LEN: usize = 6;

fn io(e: std::io::Error) -> AppError {
    AppError::Internal(e.to_string())
}

/// Ask where to save, then write the JSON backup. Returns the saved path,
/// or `None` if the user cancelled.
#[tauri::command]
pub async fn export_backup(app: AppHandle, state: State<'_, AppState>, today: String) -> AppResult<Option<String>> {
    entries::validate_date(&today)?;
    let key = state.key()?;
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Export diary backup")
        .set_file_name(format!("diary-backup-{today}.json"))
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| AppError::Internal(e.to_string()))?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let json = backup::export(&state.db.lock().unwrap(), &key, &state.data_dir, now)?;
    std::fs::write(&path, json).map_err(io)?;
    Ok(Some(path.display().to_string()))
}

/// Ask where to save, then stream an encrypted backup there. Written to a
/// temp name first, so a failure can't leave a partial file that looks whole.
#[tauri::command]
pub async fn export_encrypted_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    today: String,
    password: String,
    include_videos: bool,
) -> AppResult<Option<String>> {
    entries::validate_date(&today)?;
    let password = Zeroizing::new(password);
    if password.chars().count() < MIN_BACKUP_PASSWORD_LEN {
        return Err(AppError::Invalid(format!("Use at least {MIN_BACKUP_PASSWORD_LEN} characters for the backup password")));
    }
    let key = state.key()?;
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Save encrypted backup")
        .set_file_name(format!("diary-backup-{today}.diarybackup"))
        .add_filter("Diary backup", &["diarybackup"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| AppError::Internal(e.to_string()))?;
    let snapshot = backup::snapshot(&state.db.lock().unwrap(), &key)?;
    let salt = crypto::random_bytes::<16>();
    let backup_key = crypto::derive_kek(&password, &salt)?;
    auto_backup::write_file(&path, &snapshot, &key, &state.data_dir, &backup_key, &salt, include_videos)?;
    Ok(Some(path.display().to_string()))
}

/// Merge an encrypted backup the user has already chosen.
#[tauri::command]
pub async fn import_encrypted_backup(state: State<'_, AppState>, path: String, password: String) -> AppResult<ImportResult> {
    let password = Zeroizing::new(password);
    let key = state.key()?;
    let file = std::io::BufReader::new(std::fs::File::open(&path).map_err(io)?);
    let reader = backup::open_sealed(file, &password)
        .map_err(|_| AppError::Invalid("Wrong backup password, or the file is damaged".into()))?;
    backup::import_sealed(&state.db, &key, &state.data_dir, reader)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    #[serde(flatten)]
    result: Option<ImportResult>,
    /// Set when the chosen file is encrypted: ask for its password, then call
    /// `import_encrypted_backup` with this path.
    needs_password: Option<String>,
}

/// Ask for a backup file. A plain one is merged straight away. `None` if the
/// user cancelled.
#[tauri::command]
pub async fn import_backup(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<ImportOutcome>> {
    let key = state.key()?;
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Import diary backup")
        .add_filter("Diary backup", &["diarybackup", "json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| AppError::Internal(e.to_string()))?;
    let mut head = [0u8; 8];
    let is_sealed = std::fs::File::open(&path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && backup::is_sealed(&head);
    if is_sealed {
        return Ok(Some(ImportOutcome { result: None, needs_password: Some(path.display().to_string()) }));
    }
    let json = std::fs::read(&path).map_err(io)?;
    let result = backup::import(&mut state.db.lock().unwrap(), &key, &state.data_dir, &json)?;
    Ok(Some(ImportOutcome { result: Some(result), needs_password: None }))
}

#[tauri::command]
pub fn get_auto_backup(state: State<'_, AppState>) -> AppResult<Option<AutoBackupInfo>> {
    let key = state.key()?;
    let mut info = auto_backup::info(&state.db.lock().unwrap(), &key)?;
    if let Some(info) = info.as_mut() {
        info.running = state.auto_backup_running.load(std::sync::atomic::Ordering::SeqCst);
    }
    Ok(info)
}

/// Ask for a folder and turn automatic encrypted backups on. `false` if cancelled.
#[tauri::command]
pub async fn enable_auto_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
    every_days: u32,
    include_videos: bool,
) -> AppResult<bool> {
    let password = Zeroizing::new(password);
    if password.chars().count() < MIN_BACKUP_PASSWORD_LEN {
        return Err(AppError::Invalid(format!("Use at least {MIN_BACKUP_PASSWORD_LEN} characters for the backup password")));
    }
    let key = state.key()?;
    let Some(folder) = app.dialog().file().set_title("Choose a folder for backups").blocking_pick_folder() else {
        return Ok(false);
    };
    let folder = folder.into_path().map_err(|e| AppError::Internal(e.to_string()))?;
    let config = auto_backup::new_config(folder, &password, every_days, include_videos)?;
    auto_backup::save(&state.db.lock().unwrap(), &key, &config)?;
    Ok(true)
}

#[tauri::command]
pub fn disable_auto_backup(state: State<'_, AppState>) -> AppResult<()> {
    state.key()?;
    auto_backup::remove(&state.db.lock().unwrap())
}

/// Start a backup on a background thread if one is due (or `force`d).
/// Returns whether one was started.
#[tauri::command]
pub fn run_auto_backup(app: AppHandle, state: State<'_, AppState>, today: String, force: bool) -> AppResult<bool> {
    entries::validate_date(&today)?;
    auto_backup::start_if_due(app, &state, today, force)
}

/// The daily reminder time as "HH:MM", or null when off.
#[tauri::command]
pub fn get_reminder(state: State<'_, AppState>) -> AppResult<Option<String>> {
    state.key()?;
    let stored = db::get_meta(&state.db.lock().unwrap(), "reminder")?;
    Ok(stored.map(|v| String::from_utf8_lossy(&v).into_owned()))
}

#[tauri::command]
pub fn set_reminder(state: State<'_, AppState>, time: Option<String>) -> AppResult<()> {
    state.key()?;
    let conn = state.db.lock().unwrap();
    match time {
        Some(time) => {
            let (hour, minute) = reminder::parse_time(&time)?;
            reminder::install(hour, minute)?;
            db::set_meta(&conn, "reminder", time.as_bytes())?;
        }
        None => {
            reminder::uninstall()?;
            conn.execute("DELETE FROM meta WHERE key = 'reminder'", [])?;
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricStatus {
    available: bool,
    enabled: bool,
}

fn touch_id_enabled(state: &AppState) -> AppResult<bool> {
    Ok(db::get_meta(&state.db.lock().unwrap(), "touch_id")?.is_some())
}

#[tauri::command]
pub fn biometric_status(state: State<'_, AppState>) -> AppResult<BiometricStatus> {
    Ok(BiometricStatus { available: biometric::available(), enabled: touch_id_enabled(&state)? })
}

/// Turn Touch ID on: confirm the fingerprint, then keep a copy of the data
/// key in the Keychain plus a check value to verify it on later unlocks.
#[tauri::command]
pub async fn enable_touch_id(state: State<'_, AppState>) -> AppResult<()> {
    let key = state.key()?;
    tauri::async_runtime::spawn_blocking(|| biometric::authenticate("turn on Touch ID for your diary"))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    biometric::store_key(&key)?;
    let check = crypto::encrypt_aad(&key, b"ok", b"touch-id-check")?;
    let conn = state.db.lock().unwrap();
    db::set_meta(&conn, "touch_id_check", &check)?;
    db::set_meta(&conn, "touch_id", b"1")?;
    Ok(())
}

#[tauri::command]
pub fn disable_touch_id(state: State<'_, AppState>) -> AppResult<()> {
    biometric::delete_key();
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM meta WHERE key IN ('touch_id', 'touch_id_check')", [])?;
    Ok(())
}

#[tauri::command]
pub async fn unlock_with_touch_id(state: State<'_, AppState>) -> AppResult<()> {
    if !touch_id_enabled(&state)? {
        return Err(AppError::Invalid("Touch ID is not turned on".into()));
    }
    let key = tauri::async_runtime::spawn_blocking(|| {
        biometric::authenticate("unlock your diary")?;
        biometric::load_key()
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    // Make sure the Keychain copy really is this diary's key.
    let check = db::get_meta(&state.db.lock().unwrap(), "touch_id_check")?.ok_or(AppError::Crypto)?;
    crypto::decrypt_aad(&key, &check, b"touch-id-check")
        .map_err(|_| AppError::Invalid("Touch ID key is out of date — please use your password".into()))?;
    *state.key.lock().unwrap() = Some(key);
    Ok(())
}

/// Folder holding diary.db and photos (shown in Settings).
#[tauri::command]
pub fn data_location(state: State<'_, AppState>) -> String {
    state.data_dir.display().to_string()
}
