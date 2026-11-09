//! The daily reminder. People write at night, usually with the app closed, so
//! this can't be a timer inside the app. On the Mac a small launchd job shows
//! the notification; on the iPhone the system schedules a repeating local
//! notification. Its text is fixed and contains nothing from the diary.

use tauri::{AppHandle, Runtime};

use crate::error::{AppError, AppResult};

const MESSAGE: &str = "Your diary is here if you want to write.";

pub fn parse_time(time: &str) -> AppResult<(u8, u8)> {
    let parsed = time.split_once(':').and_then(|(h, m)| Some((h.parse::<u8>().ok()?, m.parse::<u8>().ok()?)));
    match parsed {
        Some((h, m)) if h < 24 && m < 60 => Ok((h, m)),
        _ => Err(AppError::Invalid("Invalid reminder time".into())),
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    pub(super) const LABEL: &str = "com.harjotsingh.diary.reminder";

    fn plist_path() -> AppResult<PathBuf> {
        let home = std::env::var_os("HOME").ok_or_else(|| AppError::Internal("HOME is not set".into()))?;
        Ok(PathBuf::from(home).join("Library/LaunchAgents").join(format!("{LABEL}.plist")))
    }

    pub(super) fn plist(hour: u8, minute: u8) -> String {
        let script = format!("display notification \"{MESSAGE}\" with title \"Diary\"");
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/osascript</string>
		<string>-e</string>
		<string>{script}</string>
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>{hour}</integer>
		<key>Minute</key>
		<integer>{minute}</integer>
	</dict>
</dict>
</plist>
"#
        )
    }

    fn launchctl(args: &[&str]) -> AppResult<std::process::Output> {
        Command::new("/bin/launchctl").args(args).output().map_err(|e| AppError::Internal(e.to_string()))
    }

    /// Install or reschedule the job.
    pub fn install<R: Runtime>(_: &AppHandle<R>, hour: u8, minute: u8) -> AppResult<()> {
        let path = plist_path()?;
        let io = |e: std::io::Error| AppError::Internal(e.to_string());
        std::fs::create_dir_all(path.parent().expect("has a parent")).map_err(io)?;
        let shown = path.display().to_string();
        if path.exists() {
            let _ = launchctl(&["unload", &shown]); // reloading is how launchd picks up a new time
        }
        std::fs::write(&path, plist(hour, minute)).map_err(io)?;
        let out = launchctl(&["load", &shown])?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&path);
            return Err(AppError::Internal("Couldn't schedule the reminder".into()));
        }
        Ok(())
    }

    pub fn uninstall<R: Runtime>(_: &AppHandle<R>) -> AppResult<()> {
        let path = plist_path()?;
        if path.exists() {
            let _ = launchctl(&["unload", &path.display().to_string()]);
            std::fs::remove_file(&path).map_err(|e| AppError::Internal(e.to_string()))?;
        }
        Ok(())
    }
}

#[cfg(target_os = "ios")]
mod imp {
    use super::*;
    use tauri_plugin_notification::{NotificationExt, PermissionState, Schedule, ScheduleInterval};

    const ID: i32 = 1;

    pub fn install<R: Runtime>(app: &AppHandle<R>, hour: u8, minute: u8) -> AppResult<()> {
        let fail = |e: tauri_plugin_notification::Error| AppError::Internal(e.to_string());
        let notifications = app.notification();
        if notifications.request_permission().map_err(fail)? != PermissionState::Granted {
            return Err(AppError::Invalid("Notifications are off. Allow them for Diary in Settings → Notifications.".into()));
        }
        let _ = notifications.cancel(vec![ID]);
        let interval = ScheduleInterval { hour: Some(hour), minute: Some(minute), second: Some(0), ..Default::default() };
        notifications
            .builder()
            .id(ID)
            .title("Diary")
            .body(MESSAGE)
            .schedule(Schedule::Interval { interval, allow_while_idle: true })
            .show()
            .map_err(fail)
    }

    pub fn uninstall<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
        app.notification().cancel(vec![ID]).map_err(|e| AppError::Internal(e.to_string()))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod imp {
    use super::*;
    pub fn install<R: Runtime>(_: &AppHandle<R>, _: u8, _: u8) -> AppResult<()> {
        Err(AppError::Invalid("Reminders aren't available on this system".into()))
    }
    pub fn uninstall<R: Runtime>(_: &AppHandle<R>) -> AppResult<()> { Ok(()) }
}

pub use imp::{install, uninstall};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_real_times() {
        assert_eq!(parse_time("21:30").unwrap(), (21, 30));
        assert_eq!(parse_time("00:00").unwrap(), (0, 0));
        for bad in ["24:00", "12:60", "noon", "12", ""] {
            assert!(parse_time(bad).is_err(), "{bad}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn job_runs_at_the_chosen_time_without_diary_content() {
        use super::imp::{plist, LABEL};
        let text = plist(21, 5);
        assert!(text.contains("<key>Hour</key>\n\t\t<integer>21</integer>"));
        assert!(text.contains("<key>Minute</key>\n\t\t<integer>5</integer>"));
        assert!(text.contains(LABEL));
    }
}
