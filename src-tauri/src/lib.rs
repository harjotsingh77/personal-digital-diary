//! Diary backend: owns the SQLite database and all cryptography.
//! The frontend never sees raw keys — it only calls the commands below.

mod attachments;
mod auto_backup;
mod backup;
mod biometric;
mod commands;
mod crypto;
mod db;
mod entries;
mod error;
mod reminder;
mod sealed;
mod search;
mod speech;
mod state;
mod stats;
mod video;

use tauri::http::{Request, Response, StatusCode};
use tauri::Manager;

/// Most a single range response returns; the player asks again for the rest.
const VIDEO_CHUNK: u64 = 4 * 1024 * 1024;

fn video_response(state: &state::AppState, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let status_only = |status: StatusCode| Response::builder().status(status).body(vec![]).unwrap();
    let Ok(key) = state.key() else { return status_only(StatusCode::FORBIDDEN) };
    let id = request.uri().path().trim_start_matches('/');
    let Ok(total) = video::size(&state.data_dir, id) else { return status_only(StatusCode::NOT_FOUND) };
    let range = request.headers().get("range").and_then(|v| v.to_str().ok()).unwrap_or("");
    let (start, end) = parse_range(range, total);
    if start >= end {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header("Content-Range", format!("bytes */{total}"))
            .body(vec![])
            .unwrap();
    }
    let Ok(bytes) = video::read_range(&state.data_dir, &key, id, start, end) else {
        return status_only(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let mime = if request.uri().query() == Some("t=webm") { "video/webm" } else { "video/mp4" };
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", format!("bytes {start}-{}/{total}", start + bytes.len() as u64 - 1))
        .body(bytes)
        .unwrap()
}

/// `bytes=a-b` (or the suffix form `bytes=-n`, the last n bytes) as a
/// half-open range capped at `VIDEO_CHUNK`. No header starts at 0. An empty
/// result (start >= end) means the range can't be satisfied.
fn parse_range(header: &str, total: u64) -> (u64, u64) {
    let spec = header.trim().strip_prefix("bytes=").unwrap_or("0-");
    // Only the first range of a multi-range request is served.
    let spec = spec.split(',').next().unwrap_or("0-").trim();
    let (a, b) = spec.split_once('-').unwrap_or(("0", ""));
    let (start, wanted_end) = if a.is_empty() {
        let last = b.parse::<u64>().unwrap_or(0);
        (total.saturating_sub(last), total)
    } else {
        let Ok(start) = a.parse::<u64>() else { return (0, 0) };
        (start, b.parse::<u64>().map_or(total, |b| b.saturating_add(1)))
    };
    (start, wanted_end.min(total).min(start.saturating_add(VIDEO_CHUNK)))
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn range_headers() {
        assert_eq!(parse_range("bytes=0-1", 100), (0, 2));
        assert_eq!(parse_range("bytes=10-", 100), (10, 100));
        assert_eq!(parse_range("", 100), (0, 100));
        assert_eq!(parse_range("bytes=0-", u64::MAX), (0, 4 * 1024 * 1024));
        assert_eq!(parse_range("bytes=90-500", 100), (90, 100));
        // Suffix ranges ask for the last n bytes.
        assert_eq!(parse_range("bytes=-10", 100), (90, 100));
        assert_eq!(parse_range("bytes=-500", 100), (0, 100));
        // Backwards or garbled ranges come out empty, so they get a 416.
        let (a, b) = parse_range("bytes=50-10", 100);
        assert!(a >= b);
        let (a, b) = parse_range("bytes=x-10", 100);
        assert!(a >= b);
        assert_eq!(parse_range("bytes=0-1, 5-9", 100), (0, 2));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_notification::init());
    builder
        // Plays encrypted videos: decrypts just the byte ranges the player asks for.
        .register_asynchronous_uri_scheme_protocol("diaryvideo", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(video_response(&app.state::<state::AppState>(), &request));
            });
        })
        .setup(|app| {
            // ~/Library/Application Support/com.harjotsingh.diary/
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::open(&data_dir.join("diary.db"))?;
            app.manage(state::AppState::new(conn, data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::auth::auth_status,
            commands::auth::setup_password,
            commands::auth::unlock,
            commands::auth::lock,
            commands::auth::change_password,
            commands::entries::get_entry,
            commands::entries::save_entry,
            commands::entries::delete_entry,
            commands::entries::list_entries,
            commands::auth::create_recovery_key,
            commands::auth::has_recovery_key,
            commands::auth::recover_with_key,
            commands::library::search_entries,
            commands::library::on_this_day,
            commands::library::list_photos,
            commands::library::video_begin,
            commands::library::video_append,
            commands::library::video_finish,
            commands::library::video_cancel,
            commands::library::delete_video_note,
            commands::library::transcribe_voice_note,
            commands::library::print_page,
            commands::library::list_tags,
            commands::library::get_stats,
            commands::library::add_photo,
            commands::library::get_photo,
            commands::library::delete_photo,
            commands::library::add_voice_note,
            commands::library::get_voice_note,
            commands::library::delete_voice_note,
            commands::settings::export_backup,
            commands::settings::export_encrypted_backup,
            commands::settings::import_backup,
            commands::settings::import_encrypted_backup,
            commands::settings::get_auto_backup,
            commands::settings::enable_auto_backup,
            commands::settings::disable_auto_backup,
            commands::settings::run_auto_backup,
            commands::settings::get_reminder,
            commands::settings::set_reminder,
            commands::settings::biometric_status,
            commands::settings::enable_touch_id,
            commands::settings::disable_touch_id,
            commands::settings::unlock_with_touch_id,
            commands::settings::data_location,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Diary");
}
