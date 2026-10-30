//! Photo and voice-note attachments. Each one is a file in
//! `<app data>/photos/` or `<app data>/voice/`, named by a random id and
//! encrypted with the data key (AES-256-GCM, with kind + id as associated
//! data). Entries reference attachments by id. Videos are too big for this
//! and have their own module, `video.rs`.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::crypto::{self, Key};
use crate::error::{AppError, AppResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Photo,
    Voice,
}

impl Kind {
    fn dir_name(self) -> &'static str {
        match self {
            Kind::Photo => "photos",
            Kind::Voice => "voice",
        }
    }

    fn aad_prefix(self) -> &'static str {
        match self {
            Kind::Photo => "photo",
            Kind::Voice => "voice",
        }
    }

    /// Generous limits: the frontend already downsizes large camera images,
    /// and voice notes are compressed audio (~1 MB per minute).
    fn max_bytes(self) -> usize {
        match self {
            Kind::Photo => 30 * 1024 * 1024,
            Kind::Voice => 50 * 1024 * 1024,
        }
    }

    fn too_large(self) -> &'static str {
        match self {
            Kind::Photo => "Photo is empty or too large (max 30 MB)",
            Kind::Voice => "Voice note is empty or too long",
        }
    }
}

fn dir(data_dir: &Path, kind: Kind) -> PathBuf {
    data_dir.join(kind.dir_name())
}

/// Ids are 32 lowercase hex chars — checked so an id can never be a path.
pub fn validate_id(id: &str) -> AppResult<()> {
    if id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(())
    } else {
        Err(AppError::Invalid("Invalid attachment id".into()))
    }
}

fn path_for(data_dir: &Path, kind: Kind, id: &str) -> AppResult<PathBuf> {
    validate_id(id)?;
    Ok(dir(data_dir, kind).join(format!("{id}.enc")))
}

fn aad(kind: Kind, id: &str) -> Vec<u8> {
    format!("{}:{id}", kind.aad_prefix()).into_bytes()
}

fn io(e: std::io::Error) -> AppError {
    AppError::Internal(e.to_string())
}

pub fn add(data_dir: &Path, key: &Key, kind: Kind, bytes: &[u8]) -> AppResult<String> {
    let id: String = crypto::random_bytes::<16>().iter().map(|b| format!("{b:02x}")).collect();
    put(data_dir, key, kind, &id, bytes)?;
    Ok(id)
}

/// Encrypt and store `bytes` under a specific id (new attachments, backup import).
pub fn put(data_dir: &Path, key: &Key, kind: Kind, id: &str, bytes: &[u8]) -> AppResult<()> {
    if bytes.is_empty() || bytes.len() > kind.max_bytes() {
        return Err(AppError::Invalid(kind.too_large().into()));
    }
    validate_id(id)?;
    fs::create_dir_all(dir(data_dir, kind)).map_err(io)?;
    let blob = crypto::encrypt_aad(key, bytes, &aad(kind, id))?;
    // Write to a temp file then rename, so a crash never leaves half a file.
    let path = path_for(data_dir, kind, id)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, blob).map_err(io)?;
    fs::rename(&tmp, &path).map_err(io)?;
    Ok(())
}

pub fn get(data_dir: &Path, key: &Key, kind: Kind, id: &str) -> AppResult<Vec<u8>> {
    let blob = fs::read(path_for(data_dir, kind, id)?).map_err(io)?;
    Ok(crypto::decrypt_aad(key, &blob, &aad(kind, id))?.to_vec())
}

pub fn delete(data_dir: &Path, kind: Kind, id: &str) -> AppResult<()> {
    match fs::remove_file(path_for(data_dir, kind, id)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io(e)),
        _ => Ok(()),
    }
}

/// Delete stored files of `kind` whose id isn't in `keep`. Returns how many went.
pub fn prune(data_dir: &Path, kind: Kind, keep: &HashSet<String>) -> AppResult<usize> {
    let entries = match fs::read_dir(dir(data_dir, kind)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        other => other.map_err(io)?,
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".enc")) else { continue };
        if validate_id(id).is_ok() && !keep.contains(id) {
            delete(data_dir, kind, id)?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypted_on_disk() {
        let tmp = std::env::temp_dir().join(format!("diary-test-{}", std::process::id()));
        let key = crypto::random_key();
        let id = add(&tmp, &key, Kind::Photo, b"\x89PNG fake image").unwrap();
        let raw = fs::read(path_for(&tmp, Kind::Photo, &id).unwrap()).unwrap();
        assert!(!raw.windows(4).any(|w| w == b"\x89PNG"));
        assert_eq!(get(&tmp, &key, Kind::Photo, &id).unwrap(), b"\x89PNG fake image");
        delete(&tmp, Kind::Photo, &id).unwrap();
        assert!(get(&tmp, &key, Kind::Photo, &id).is_err());
        let _ = fs::remove_dir_all(tmp);
    }

    #[test]
    fn kinds_are_kept_apart() {
        let tmp = std::env::temp_dir().join(format!("diary-test-kinds-{}", std::process::id()));
        let key = crypto::random_key();
        let id = add(&tmp, &key, Kind::Voice, b"ftypM4A audio").unwrap();
        assert!(tmp.join("voice").join(format!("{id}.enc")).exists());
        assert_eq!(get(&tmp, &key, Kind::Voice, &id).unwrap(), b"ftypM4A audio");
        // Not readable as a photo, even if the file is moved across.
        assert!(get(&tmp, &key, Kind::Photo, &id).is_err());
        fs::create_dir_all(tmp.join("photos")).unwrap();
        fs::copy(path_for(&tmp, Kind::Voice, &id).unwrap(), path_for(&tmp, Kind::Photo, &id).unwrap()).unwrap();
        assert!(get(&tmp, &key, Kind::Photo, &id).is_err());
        let _ = fs::remove_dir_all(tmp);
    }

    #[test]
    fn prune_keeps_only_referenced() {
        let tmp = std::env::temp_dir().join(format!("diary-test-prune-{}", std::process::id()));
        let key = crypto::random_key();
        let keep = add(&tmp, &key, Kind::Voice, b"keep").unwrap();
        let gone = add(&tmp, &key, Kind::Voice, b"gone").unwrap();
        let photo = add(&tmp, &key, Kind::Photo, b"photo").unwrap();
        assert_eq!(prune(&tmp, Kind::Voice, &HashSet::from([keep.clone()])).unwrap(), 1);
        assert!(get(&tmp, &key, Kind::Voice, &keep).is_ok());
        assert!(get(&tmp, &key, Kind::Voice, &gone).is_err());
        assert!(get(&tmp, &key, Kind::Photo, &photo).is_ok());
        let _ = fs::remove_dir_all(tmp);
    }

    #[test]
    fn rejects_path_like_ids() {
        assert!(validate_id("../../etc/passwd").is_err());
        assert!(validate_id("ABCDEF0123456789abcdef0123456789").is_err());
        assert!(validate_id("abcdef0123456789abcdef0123456789").is_ok());
    }
}
