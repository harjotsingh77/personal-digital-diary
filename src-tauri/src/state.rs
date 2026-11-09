use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use crate::crypto::Key;
use crate::error::{AppError, AppResult};
use crate::video::VideoWriter;

/// Shared app state. `key` holds the decrypted data key only while the
/// diary is unlocked; locking drops it (and `Key` zeroes itself on drop).
pub struct AppState {
    pub db: Mutex<Connection>,
    pub key: Mutex<Option<Key>>,
    pub data_dir: PathBuf,
    /// The video recording in progress, if any. One at a time.
    pub video: Mutex<Option<VideoWriter>>,
    /// True while an automatic backup is being written.
    pub auto_backup_running: AtomicBool,
    /// Backup imports in progress. Their attachment files are written before
    /// the entries that refer to them, so locking mustn't prune meanwhile.
    imports_running: AtomicUsize,
}

/// Marks an import as running until dropped.
pub struct ImportGuard<'a>(&'a AtomicUsize);

impl Drop for ImportGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl AppState {
    pub fn new(conn: Connection, data_dir: PathBuf) -> Self {
        Self { db: Mutex::new(conn), key: Mutex::new(None), data_dir, video: Mutex::new(None), auto_backup_running: AtomicBool::new(false), imports_running: AtomicUsize::new(0) }
    }

    /// Copy of the data key, or `Locked` if the diary isn't unlocked.
    pub fn key(&self) -> AppResult<Key> {
        self.key.lock().unwrap().clone().ok_or(AppError::Locked)
    }

    pub fn begin_import(&self) -> ImportGuard<'_> {
        self.imports_running.fetch_add(1, Ordering::SeqCst);
        ImportGuard(&self.imports_running)
    }

    pub fn import_running(&self) -> bool {
        self.imports_running.load(Ordering::SeqCst) > 0
    }
}
