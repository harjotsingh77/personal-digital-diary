//! Streaming encryption for data too big to hold in memory (videos, backups).
//!
//! A sealed stream is a run of AES-256-GCM frames, each holding `FRAME` bytes
//! of plaintext except the last. Every frame's associated data carries the
//! stream's domain, its position and whether it is the last one, so frames
//! can't be reordered, swapped between streams, or cut off unnoticed.
//! Fixed-size frames also let a player seek without decrypting from the start.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use crate::crypto::{self, Key};
use crate::error::{AppError, AppResult};

pub const FRAME: usize = 1024 * 1024;
/// Nonce (12) + GCM tag (16).
const OVERHEAD: usize = 28;

fn frame_aad(domain: &str, index: u64, last: bool) -> Vec<u8> {
    format!("{domain}:{index}:{}", u8::from(last)).into_bytes()
}

pub struct SealedWriter<W: Write> {
    out: W,
    key: Key,
    domain: String,
    buf: Vec<u8>,
    index: u64,
}

impl<W: Write> SealedWriter<W> {
    pub fn new(out: W, key: Key, domain: String) -> Self {
        Self { out, key, domain, buf: Vec::with_capacity(FRAME), index: 0 }
    }

    /// Encrypt the remaining bytes as the final frame. Without this the
    /// stream reads as truncated, so forgetting it can't look like success.
    pub fn finish(mut self) -> AppResult<W> {
        self.seal_frame(true)?;
        self.out.flush().map_err(io_err)?;
        Ok(self.out)
    }

    fn seal_frame(&mut self, last: bool) -> AppResult<()> {
        let len = self.buf.len().min(FRAME);
        let blob = crypto::encrypt_aad(&self.key, &self.buf[..len], &frame_aad(&self.domain, self.index, last))?;
        self.out.write_all(&blob).map_err(io_err)?;
        self.buf.drain(..len);
        self.index += 1;
        Ok(())
    }
}

impl<W: Write> Write for SealedWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        // Strictly more than a frame: the final frame must stay unwritten
        // until `finish`, even when the data ends exactly on a boundary.
        while self.buf.len() > FRAME {
            self.seal_frame(false).map_err(|e| io::Error::other(e.to_string()))?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Reads a sealed stream from start to end.
pub struct SealedReader<R: Read> {
    input: R,
    key: Key,
    domain: String,
    index: u64,
    /// The next frame, read ahead so the current one knows if it is the last.
    ahead: Vec<u8>,
    plain: zeroize::Zeroizing<Vec<u8>>,
    pos: usize,
    done: bool,
}

impl<R: Read> SealedReader<R> {
    pub fn new(mut input: R, key: Key, domain: String) -> io::Result<Self> {
        let ahead = read_frame(&mut input)?;
        Ok(Self { input, key, domain, index: 0, ahead, plain: Default::default(), pos: 0, done: false })
    }

    fn next_frame(&mut self) -> io::Result<()> {
        let current = std::mem::take(&mut self.ahead);
        self.ahead = read_frame(&mut self.input)?;
        let last = self.ahead.is_empty();
        self.plain = crypto::decrypt_aad(&self.key, &current, &frame_aad(&self.domain, self.index, last))
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "wrong key or damaged data"))?;
        self.pos = 0;
        self.index += 1;
        self.done = last;
        Ok(())
    }
}

impl<R: Read> Read for SealedReader<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        while self.pos == self.plain.len() {
            if self.done {
                return Ok(0);
            }
            self.next_frame()?;
        }
        let n = out.len().min(self.plain.len() - self.pos);
        out[..n].copy_from_slice(&self.plain[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

fn read_frame<R: Read>(input: &mut R) -> io::Result<Vec<u8>> {
    let mut frame = Vec::with_capacity(FRAME + OVERHEAD);
    input.by_ref().take((FRAME + OVERHEAD) as u64).read_to_end(&mut frame)?;
    Ok(frame)
}

/// Plaintext size of a sealed file that is `file_len` bytes long.
pub fn plain_len(file_len: u64) -> u64 {
    let frames = file_len.div_ceil((FRAME + OVERHEAD) as u64);
    file_len.saturating_sub(frames * OVERHEAD as u64)
}

/// Decrypt bytes `start..end` of a sealed file, touching only the frames needed.
pub fn read_range(path: &Path, key: &Key, domain: &str, start: u64, end: u64) -> AppResult<Vec<u8>> {
    let mut file = File::open(path).map_err(io_err)?;
    let file_len = file.metadata().map_err(io_err)?.len();
    let total = plain_len(file_len);
    let end = end.min(total);
    if start >= end {
        return Ok(vec![]);
    }
    let frame_count = file_len.div_ceil((FRAME + OVERHEAD) as u64);
    let mut out = Vec::with_capacity((end - start) as usize);
    let mut index = start / FRAME as u64;
    file.seek(SeekFrom::Start(index * (FRAME + OVERHEAD) as u64)).map_err(io_err)?;
    while (index * FRAME as u64) < end {
        let frame = read_frame(&mut file).map_err(io_err)?;
        let plain = crypto::decrypt_aad(key, &frame, &frame_aad(domain, index, index + 1 == frame_count))?;
        let frame_start = index * FRAME as u64;
        let from = start.saturating_sub(frame_start) as usize;
        let to = ((end - frame_start) as usize).min(plain.len());
        out.extend_from_slice(&plain[from..to]);
        index += 1;
    }
    Ok(out)
}

fn io_err(e: io::Error) -> AppError {
    AppError::Internal(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sealed(data: &[u8], key: &Key, domain: &str) -> Vec<u8> {
        let mut w = SealedWriter::new(Vec::new(), key.clone(), domain.into());
        w.write_all(data).unwrap();
        w.finish().unwrap()
    }

    fn opened(blob: &[u8], key: &Key, domain: &str) -> io::Result<Vec<u8>> {
        let mut out = Vec::new();
        SealedReader::new(blob, key.clone(), domain.into())?.read_to_end(&mut out)?;
        Ok(out)
    }

    #[test]
    fn roundtrips_at_every_frame_boundary() {
        let key = crypto::random_key();
        for len in [0, 1, FRAME - 1, FRAME, FRAME + 1, FRAME * 2, FRAME * 2 + 7] {
            let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let blob = sealed(&data, &key, "t");
            assert_eq!(opened(&blob, &key, "t").unwrap(), data, "len {len}");
            assert_eq!(plain_len(blob.len() as u64), len as u64, "len {len}");
        }
    }

    #[test]
    fn detects_truncation_wrong_key_and_wrong_domain() {
        let key = crypto::random_key();
        let blob = sealed(&vec![7u8; FRAME * 2 + 5], &key, "t");
        // Dropping the last frame leaves a valid-looking prefix.
        assert!(opened(&blob[..FRAME + OVERHEAD], &key, "t").is_err());
        assert!(opened(&blob, &crypto::random_key(), "t").is_err());
        assert!(opened(&blob, &key, "other").is_err());
    }

    #[test]
    fn ranges_match_the_plaintext() {
        let key = crypto::random_key();
        let data: Vec<u8> = (0..FRAME * 3 + 123).map(|i| (i % 251) as u8).collect();
        let path = std::env::temp_dir().join(format!("diary-sealed-{}", std::process::id()));
        std::fs::write(&path, sealed(&data, &key, "v")).unwrap();
        for (a, b) in [(0, 2), (FRAME - 1, FRAME + 1), (FRAME * 2 + 9, FRAME * 3 + 123), (5, 5)] {
            let got = read_range(&path, &key, "v", a as u64, b as u64).unwrap();
            assert_eq!(got, &data[a..b], "{a}..{b}");
        }
        // Past the end is clamped, not an error.
        assert_eq!(read_range(&path, &key, "v", (FRAME * 3) as u64, u64::MAX).unwrap().len(), 123);
        let _ = std::fs::remove_file(path);
    }
}
