//! Search, tags, stats, photos and voice notes.

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use crate::attachments::{self, Kind};
use crate::entries::EntrySummary;
use crate::error::{AppError, AppResult};
use crate::search::{self, Filters, PhotoRef, TagCount};
use crate::video::{self, VideoWriter};
use crate::state::AppState;
use crate::stats::{self, Stats};

#[tauri::command]
pub fn search_entries(state: State<'_, AppState>, query: String, filters: Option<Filters>) -> AppResult<Vec<EntrySummary>> {
    let key = state.key()?;
    search::search(&state.db.lock().unwrap(), &key, &query, &filters.unwrap_or_default())
}

#[tauri::command]
pub fn on_this_day(state: State<'_, AppState>, today: String) -> AppResult<Vec<EntrySummary>> {
    let key = state.key()?;
    search::on_this_day(&state.db.lock().unwrap(), &key, &today)
}

#[tauri::command]
pub fn list_photos(state: State<'_, AppState>) -> AppResult<Vec<PhotoRef>> {
    let key = state.key()?;
    search::photos(&state.db.lock().unwrap(), &key)
}

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> AppResult<Vec<TagCount>> {
    let key = state.key()?;
    search::tags(&state.db.lock().unwrap(), &key)
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>, today: String) -> AppResult<Stats> {
    state.key()?; // only available while unlocked
    stats::compute(&state.db.lock().unwrap(), &today)
}

/// Receives the image as a raw binary body (no JSON/base64 overhead) and
/// returns the new photo id.
#[tauri::command]
pub fn add_photo(state: State<'_, AppState>, request: Request<'_>) -> AppResult<String> {
    let key = state.key()?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Invalid("Expected raw image bytes".into()));
    };
    attachments::add(&state.data_dir, &key, Kind::Photo, bytes)
}

/// Returns decrypted image bytes as a raw binary response (an ArrayBuffer in JS).
#[tauri::command]
pub fn get_photo(state: State<'_, AppState>, id: String) -> AppResult<Response> {
    let key = state.key()?;
    Ok(Response::new(attachments::get(&state.data_dir, &key, Kind::Photo, &id)?))
}

#[tauri::command]
pub fn delete_photo(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.key()?;
    attachments::delete(&state.data_dir, Kind::Photo, &id)
}

/// Receives a recorded voice note as a raw binary body and returns its id.
#[tauri::command]
pub fn add_voice_note(state: State<'_, AppState>, request: Request<'_>) -> AppResult<String> {
    let key = state.key()?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Invalid("Expected raw audio bytes".into()));
    };
    attachments::add(&state.data_dir, &key, Kind::Voice, bytes)
}

/// Returns decrypted audio bytes as a raw binary response.
#[tauri::command]
pub fn get_voice_note(state: State<'_, AppState>, id: String) -> AppResult<Response> {
    let key = state.key()?;
    Ok(Response::new(attachments::get(&state.data_dir, &key, Kind::Voice, &id)?))
}

#[tauri::command]
pub fn delete_voice_note(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.key()?;
    attachments::delete(&state.data_dir, Kind::Voice, &id)
}

/// Start streaming a video recording to disk. Replaces any abandoned one.
#[tauri::command]
pub fn video_begin(state: State<'_, AppState>) -> AppResult<()> {
    let key = state.key()?;
    let writer = VideoWriter::begin(&state.data_dir, &key)?;
    if let Some(old) = state.video.lock().unwrap().replace(writer) {
        old.cancel();
    }
    Ok(())
}

/// Receives the next recorded chunk as a raw binary body.
#[tauri::command]
pub fn video_append(state: State<'_, AppState>, request: Request<'_>) -> AppResult<()> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Invalid("Expected raw video bytes".into()));
    };
    match state.video.lock().unwrap().as_mut() {
        Some(writer) => writer.append(bytes),
        None => Err(AppError::Invalid("No video is being recorded".into())),
    }
}

/// Seal the recording and return its id.
#[tauri::command]
pub fn video_finish(state: State<'_, AppState>) -> AppResult<String> {
    match state.video.lock().unwrap().take() {
        Some(writer) => writer.finish(),
        None => Err(AppError::Invalid("No video is being recorded".into())),
    }
}

#[tauri::command]
pub fn video_cancel(state: State<'_, AppState>) {
    if let Some(writer) = state.video.lock().unwrap().take() {
        writer.cancel();
    }
}

#[tauri::command]
pub fn delete_video_note(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.key()?;
    video::delete(&state.data_dir, &id)
}

/// Text of a voice note, recognised on this Mac. Nothing leaves the device.
#[tauri::command]
pub async fn transcribe_voice_note(state: State<'_, AppState>, id: String, language: String) -> AppResult<String> {
    let key = state.key()?;
    let bytes = attachments::get(&state.data_dir, &key, Kind::Voice, &id)?;
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || crate::speech::transcribe(&data_dir, &id, &bytes, &language))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Opens the system print dialog, whose PDF menu saves the book as a file.
#[tauri::command]
pub fn print_page(window: tauri::WebviewWindow) -> AppResult<()> {
    window.print().map_err(|e| AppError::Internal(e.to_string()))
}
