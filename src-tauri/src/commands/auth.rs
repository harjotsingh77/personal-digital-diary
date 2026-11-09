//! Password setup, unlock and lock.
//!
//! Stored in the `meta` table:
//!   `password_hash` — Argon2id PHC string, used to verify the password
//!   `kdf_salt`      — salt for deriving the key-encryption key (KEK)
//!   `wrapped_dek`   — the data key, encrypted with the KEK
//!   `recovery_wrapped` — the data key, encrypted with the recovery key (optional)

use serde::Serialize;
use tauri::State;
use zeroize::Zeroizing;

use crate::attachments::{self, Kind};
use crate::crypto::{self, Key};
use crate::entries;
use crate::video;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const MIN_PASSWORD_LEN: usize = 6;
const RECOVERY_AAD: &[u8] = b"recovery";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    has_password: bool,
    unlocked: bool,
    /// Touch ID is turned on and the hardware is available right now.
    touch_id: bool,
}

#[tauri::command]
pub fn auth_status(state: State<'_, AppState>) -> AppResult<AuthStatus> {
    let has_password = db::get_meta(&state.db.lock().unwrap(), "password_hash")?.is_some();
    let unlocked = state.key.lock().unwrap().is_some();
    let touch_id = db::get_meta(&state.db.lock().unwrap(), "touch_id")?.is_some() && crate::biometric::available();
    Ok(AuthStatus { has_password, unlocked, touch_id })
}

/// Run slow Argon2 work off the main thread so the UI stays responsive.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Hash + wrap a data key under `password`. Returns (phc, salt, wrapped_dek).
fn seal_dek(password: &str, dek: &Key) -> AppResult<(String, [u8; 16], Vec<u8>)> {
    let phc = crypto::hash_password(password)?;
    let salt = crypto::random_bytes::<16>();
    let kek = crypto::derive_kek(password, &salt)?;
    let wrapped = crypto::encrypt(&kek, dek.as_ref())?;
    Ok((phc, salt, wrapped))
}

/// `first` refuses to replace an existing password (first-time setup), checked
/// in the same transaction so two setups racing can't both win.
fn store_sealed(state: &AppState, phc: &str, salt: &[u8], wrapped: &[u8], first: bool) -> AppResult<()> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    if first && db::get_meta(&tx, "password_hash")?.is_some() {
        return Err(AppError::Invalid("A password is already set".into()));
    }
    db::set_meta(&tx, "password_hash", phc.as_bytes())?;
    db::set_meta(&tx, "kdf_salt", salt)?;
    db::set_meta(&tx, "wrapped_dek", wrapped)?;
    tx.commit()?;
    Ok(())
}

/// Verify `password` and return the unwrapped data key.
async fn open_dek(state: &AppState, password: Zeroizing<String>) -> AppResult<Key> {
    let (phc, salt, wrapped) = {
        let conn = state.db.lock().unwrap();
        let phc = db::get_meta(&conn, "password_hash")?
            .ok_or_else(|| AppError::Invalid("No password has been set".into()))?;
        let salt = db::get_meta(&conn, "kdf_salt")?.ok_or(AppError::Crypto)?;
        let wrapped = db::get_meta(&conn, "wrapped_dek")?.ok_or(AppError::Crypto)?;
        (String::from_utf8_lossy(&phc).into_owned(), salt, wrapped)
    };
    let result = blocking(move || {
        if !crypto::verify_password(&password, &phc) {
            return Err(AppError::WrongPassword);
        }
        let kek = crypto::derive_kek(&password, &salt)?;
        let raw = crypto::decrypt(&kek, &wrapped)?;
        let dek: [u8; 32] = raw[..].try_into().map_err(|_| AppError::Crypto)?;
        Ok(Zeroizing::new(dek))
    })
    .await;
    if result.is_err() {
        // Small penalty on failure to further slow down guessing.
        sleep_ms(800).await;
    }
    result
}

async fn sleep_ms(ms: u64) {
    let _ = blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        Ok(())
    })
    .await;
}

/// First launch: choose a password. Creates a fresh random data key.
#[tauri::command]
pub async fn setup_password(state: State<'_, AppState>, password: String) -> AppResult<()> {
    let password = Zeroizing::new(password);
    if db::get_meta(&state.db.lock().unwrap(), "password_hash")?.is_some() {
        return Err(AppError::Invalid("A password is already set".into()));
    }
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::Invalid(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters"
        )));
    }
    let dek = crypto::random_key();
    let dek_for_seal = dek.clone();
    let (phc, salt, wrapped) = blocking(move || seal_dek(&password, &dek_for_seal)).await?;
    store_sealed(&state, &phc, &salt, &wrapped, true)?;
    *state.key.lock().unwrap() = Some(dek);
    Ok(())
}

#[tauri::command]
pub async fn unlock(state: State<'_, AppState>, password: String) -> AppResult<()> {
    let dek = open_dek(&state, Zeroizing::new(password)).await?;
    *state.key.lock().unwrap() = Some(dek);
    Ok(())
}

/// Forget the data key. Entries are unreadable until the next unlock.
#[tauri::command]
pub fn lock(state: State<'_, AppState>) {
    // A voice note deleted with Backspace keeps its file so ⌘Z can bring it
    // back. That undo history is gone once the diary locks, so tidy up now.
    // Skipped (never guessed) if any entry fails to decrypt, and while a
    // backup import is running: its files arrive before the entries that
    // refer to them, so they would look unused and be deleted.
    if let (Ok(key), false) = (state.key(), state.import_running()) {
        if let Ok(keep) = entries::voice_note_ids(&state.db.lock().unwrap(), &key) {
            let _ = attachments::prune(&state.data_dir, Kind::Voice, &keep);
        }
        if let Ok(keep) = entries::video_note_ids(&state.db.lock().unwrap(), &key) {
            let _ = video::prune(&state.data_dir, &keep);
        }
    }
    // The frontend saves a recording before locking, so any left is abandoned.
    if let Some(writer) = state.video.lock().unwrap().take() {
        writer.cancel();
    }
    *state.key.lock().unwrap() = None;
}

/// Re-wrap the same data key under a new password (entries are untouched).
#[tauri::command]
pub async fn change_password(
    state: State<'_, AppState>,
    current: String,
    new_password: String,
) -> AppResult<()> {
    let new_password = Zeroizing::new(new_password);
    if new_password.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::Invalid(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters"
        )));
    }
    let dek = open_dek(&state, Zeroizing::new(current)).await?;
    let (phc, salt, wrapped) = blocking(move || seal_dek(&new_password, &dek)).await?;
    store_sealed(&state, &phc, &salt, &wrapped, false)?;
    Ok(())
}

/// Make a new recovery key (replacing any old one) after re-checking the
/// password. It wraps the same data key, so it keeps working across password
/// changes. Only the wrapped copy is stored; the key itself is shown once.
#[tauri::command]
pub async fn create_recovery_key(state: State<'_, AppState>, password: String) -> AppResult<String> {
    let dek = open_dek(&state, Zeroizing::new(password)).await?;
    let recovery = crypto::random_key();
    let wrapped = crypto::encrypt_aad(&recovery, dek.as_ref(), RECOVERY_AAD)?;
    db::set_meta(&state.db.lock().unwrap(), "recovery_wrapped", &wrapped)?;
    Ok(crypto::recovery_encode(&recovery))
}

#[tauri::command]
pub fn has_recovery_key(state: State<'_, AppState>) -> AppResult<bool> {
    Ok(db::get_meta(&state.db.lock().unwrap(), "recovery_wrapped")?.is_some())
}

/// Forgotten password: open the data key with the recovery key, set a new
/// password and unlock. A failure costs time, like a wrong password.
#[tauri::command]
pub async fn recover_with_key(state: State<'_, AppState>, recovery_key: String, new_password: String) -> AppResult<()> {
    let new_password = Zeroizing::new(new_password);
    if new_password.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::Invalid(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters"
        )));
    }
    let wrapped = db::get_meta(&state.db.lock().unwrap(), "recovery_wrapped")?
        .ok_or_else(|| AppError::Invalid("This diary has no recovery key".into()))?;
    let opened = crypto::recovery_decode(&recovery_key)
        .and_then(|recovery| crypto::decrypt_aad(&recovery, &wrapped, RECOVERY_AAD).ok())
        .and_then(|raw| <[u8; 32]>::try_from(&raw[..]).ok());
    let Some(raw) = opened else {
        sleep_ms(800).await;
        return Err(AppError::Invalid("That recovery key isn't right".into()));
    };
    let dek: Key = Zeroizing::new(raw);
    let dek_for_seal = dek.clone();
    let (phc, salt, sealed) = blocking(move || seal_dek(&new_password, &dek_for_seal)).await?;
    store_sealed(&state, &phc, &salt, &sealed, false)?;
    *state.key.lock().unwrap() = Some(dek);
    Ok(())
}
