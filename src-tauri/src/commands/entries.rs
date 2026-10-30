//! Entry commands. Thin wrappers: grab the DB + key, delegate to `entries`.

use tauri::State;

use crate::entries::{self, Entry, EntryPayload, EntrySummary};
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub fn get_entry(state: State<'_, AppState>, date: String) -> AppResult<Option<Entry>> {
    let key = state.key()?;
    entries::get(&state.db.lock().unwrap(), &key, &date)
}

/// Autosave target. Returns the saved entry, or `None` if it was empty (deleted).
#[tauri::command]
pub fn save_entry(
    state: State<'_, AppState>,
    date: String,
    payload: EntryPayload,
) -> AppResult<Option<Entry>> {
    let key = state.key()?;
    entries::save(&state.db.lock().unwrap(), &key, &date, &payload)
}

#[tauri::command]
pub fn delete_entry(state: State<'_, AppState>, date: String) -> AppResult<()> {
    state.key()?; // must be unlocked
    entries::delete(&state.db.lock().unwrap(), &date)
}

/// Summaries of all entries (or one "YYYY-MM" month), newest first.
#[tauri::command]
pub fn list_entries(state: State<'_, AppState>, month: Option<String>) -> AppResult<Vec<EntrySummary>> {
    let key = state.key()?;
    entries::list(&state.db.lock().unwrap(), &key, month.as_deref())
}
