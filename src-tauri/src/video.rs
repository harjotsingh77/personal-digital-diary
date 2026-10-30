//! Video notes. Recordings have no length limit, so they are never held in
//! memory: chunks stream from the recorder straight into a sealed file, and
//! the player reads back only the byte ranges it asks for.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use crate::attachments;
use crate::crypto::{self, Key};
use crate::error::{AppError, AppResult};
use crate::sealed::{self, SealedWriter};

const DIR: &str = "videos";

fn io(e: std::io::Error) -> AppError {
    AppError::Internal(e.to_string())
}

pub fn path_for(data_dir: &Path, id: &str) -> AppResult<PathBuf> {
    attachments::validate_id(id)?;
    Ok(data_dir.join(DIR).join(format!("{id}.enc")))
}

pub fn domain(id: &str) -> String {
    format!("video:{id}")
}

/// A recording in progress. Written to `<id>.part` and renamed when finished,
/// so a crash can't leave something that looks like a complete video.
pub struct VideoWriter {
    pub id: String,
    part: PathBuf,
    writer: SealedWriter<BufWriter<File>>,
}

impl VideoWriter {
    pub fn begin(data_dir: &Path, key: &Key) -> AppResult<Self> {
        let id: String = crypto::random_bytes::<16>().iter().map(|b| format!("{b:02x}")).collect();
        Self::with_id(data_dir, key, id)
    }

    /// Used by backup import, which must keep the id entries refer to.
    pub fn with_id(data_dir: &Path, key: &Key, id: String) -> AppResult<Self> {
        let path = path_for(data_dir, &id)?;
        fs::create_dir_all(data_dir.join(DIR)).map_err(io)?;
        let part = path.with_extension("part");
        let file = File::create(&part).map_err(io)?;
        let writer = SealedWriter::new(BufWriter::new(file), key.clone(), domain(&id));
        Ok(Self { id, part, writer })
    }

    pub fn append(&mut self, bytes: &[u8]) -> AppResult<()> {
        self.writer.write_all(bytes).map_err(io)
    }

    pub fn finish(self) -> AppResult<String> {
        self.writer.finish()?;
        fs::rename(&self.part, self.part.with_extension("enc")).map_err(io)?;
        Ok(self.id)
    }

    pub fn cancel(self) {
        let part = self.part.clone();
        drop(self.writer);
        let _ = fs::remove_file(part);
    }
}

pub fn exists(data_dir: &Path, id: &str) -> bool {
    path_for(data_dir, id).is_ok_and(|p| p.exists())
}

/// Plaintext size of a stored video.
pub fn size(data_dir: &Path, id: &str) -> AppResult<u64> {
    Ok(sealed::plain_len(fs::metadata(path_for(data_dir, id)?).map_err(io)?.len()))
}

pub fn read_range(data_dir: &Path, key: &Key, id: &str, start: u64, end: u64) -> AppResult<Vec<u8>> {
    sealed::read_range(&path_for(data_dir, id)?, key, &domain(id), start, end)
}

pub fn delete(data_dir: &Path, id: &str) -> AppResult<()> {
    match fs::remove_file(path_for(data_dir, id)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io(e)),
        _ => Ok(()),
    }
}

/// Delete videos no entry refers to, and anything left by an interrupted recording.
pub fn prune(data_dir: &Path, keep: &std::collections::HashSet<String>) -> AppResult<usize> {
    let entries = match fs::read_dir(data_dir.join(DIR)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        other => other.map_err(io)?,
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        let is_part = path.extension().is_some_and(|e| e == "part");
        let is_orphan = path.extension().is_some_and(|e| e == "enc") && !keep.contains(stem);
        if attachments::validate_id(stem).is_ok() && (is_part || is_orphan) {
            fs::remove_file(&path).map_err(io)?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn stream_finish_read_and_prune() {
        let tmp = std::env::temp_dir().join(format!("diary-video-{}", std::process::id()));
        let key = crypto::random_key();
        let data = vec![9u8; sealed::FRAME + 500];

        let mut w = VideoWriter::begin(&tmp, &key).unwrap();
        w.append(&data[..1000]).unwrap();
        w.append(&data[1000..]).unwrap();
        let id = w.finish().unwrap();

        assert_eq!(size(&tmp, &id).unwrap(), data.len() as u64);
        assert_eq!(read_range(&tmp, &key, &id, 0, 10).unwrap(), &data[..10]);
        let raw = fs::read(path_for(&tmp, &id).unwrap()).unwrap();
        assert!(!raw.windows(32).any(|w| w == [9u8; 32]));

        // A cancelled recording leaves nothing; an abandoned one is pruned.
        VideoWriter::begin(&tmp, &key).unwrap().cancel();
        let mut abandoned = VideoWriter::begin(&tmp, &key).unwrap();
        abandoned.append(b"x").unwrap();
        drop(abandoned);
        assert_eq!(prune(&tmp, &HashSet::from([id.clone()])).unwrap(), 1);
        assert!(exists(&tmp, &id));
        assert_eq!(prune(&tmp, &HashSet::new()).unwrap(), 1);
        assert!(!exists(&tmp, &id));
        let _ = fs::remove_dir_all(tmp);
    }
}
