//! SQLite storage. Schema changes are applied in order using SQLite's
//! built-in `user_version` pragma, so upgrades never lose data.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

use crate::error::AppResult;

/// Each entry is one migration; never edit old ones, only append.
const MIGRATIONS: &[&str] = &[
    // v1 — key/value store for auth material (password hash, salts, wrapped key).
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);",
    // v2 — one entry per calendar day. Only the date and timestamps are in
    // plaintext (needed for calendar/streak queries); title, body, mood and
    // tags all live inside the AES-256-GCM encrypted `payload`.
    "CREATE TABLE entries (
        id          INTEGER PRIMARY KEY,
        entry_date  TEXT NOT NULL UNIQUE,       -- YYYY-MM-DD (local date)
        created_at  INTEGER NOT NULL,           -- unix millis
        updated_at  INTEGER NOT NULL,
        payload     BLOB NOT NULL               -- nonce || ciphertext || tag
     );",
];

pub fn open(path: &Path) -> AppResult<Connection> {
    init(Connection::open(path)?)
}

/// Apply pragmas + migrations to a connection (also used by tests in-memory).
pub fn init(mut conn: Connection) -> AppResult<Connection> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn migrate(conn: &mut Connection) -> AppResult<()> {
    let current: usize = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i + 1)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn get_meta(conn: &Connection, key: &str) -> AppResult<Option<Vec<u8>>> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn set_meta(conn: &Connection, key: &str, value: &[u8]) -> AppResult<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}
