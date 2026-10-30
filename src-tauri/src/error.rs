use serde::{Serialize, Serializer};

/// Every command returns `Result<T, AppError>`; the error is sent to the
/// frontend as a plain human-readable string.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("Encryption error")]
    Crypto,
    #[error("Incorrect password")]
    WrongPassword,
    #[error("The diary is locked")]
    Locked,
    #[error("{0}")]
    Invalid(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
