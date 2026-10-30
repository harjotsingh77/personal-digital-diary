//! Cryptography primitives.
//!
//! Key hierarchy:
//!   password ──Argon2id(salt)──▶ KEK (key-encryption key, never stored)
//!   KEK ──AES-256-GCM──▶ wraps a random 256-bit DEK (data-encryption key)
//!   DEK ──AES-256-GCM──▶ encrypts every entry / photo
//!
//! Wrapping a random DEK (instead of using the password-derived key directly)
//! means changing the password only re-wraps 32 bytes instead of re-encrypting
//! the whole diary, and lets Touch ID unlock the same DEK later.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::rngs::OsRng;
use rand::RngCore;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};

/// A 256-bit key that is wiped from memory when dropped.
pub type Key = Zeroizing<[u8; 32]>;

const NONCE_LEN: usize = 12;

/// Argon2id with 64 MiB memory, 3 passes — OWASP-recommended territory and
/// roughly 0.3–0.5 s on Apple Silicon, which makes brute force expensive.
fn argon2() -> Argon2<'static> {
    let params = Params::new(64 * 1024, 3, 1, Some(32)).expect("valid argon2 params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Hash a password into a PHC string (`$argon2id$v=19$...`) for verification.
pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    argon2()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(e.to_string()))
}

/// Constant-time check of a password against a stored PHC hash.
pub fn verify_password(password: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => argon2().verify_password(password.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

/// Derive the key-encryption key from the password and a dedicated salt
/// (separate from the verification hash's salt).
pub fn derive_kek(password: &str, salt: &[u8]) -> AppResult<Key> {
    let mut out = Zeroizing::new([0u8; 32]);
    argon2()
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(out)
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    OsRng.fill_bytes(&mut buf);
    buf
}

pub fn random_key() -> Key {
    Zeroizing::new(random_bytes::<32>())
}

/// AES-256-GCM encrypt. Output layout: `nonce (12 bytes) || ciphertext+tag`.
/// A fresh random nonce is used for every call.
pub fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> AppResult<Vec<u8>> {
    encrypt_aad(key, plaintext, b"")
}

/// Like [`encrypt`], but also authenticates `aad` (associated data) without
/// storing it. Decryption fails unless the same `aad` is supplied — used to
/// bind each entry's ciphertext to its row, so rows can't be swapped around.
pub fn encrypt_aad(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> AppResult<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| AppError::Crypto)?;
    let nonce_bytes = random_bytes::<NONCE_LEN>();
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), Payload { msg: plaintext, aad })
        .map_err(|_| AppError::Crypto)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// AES-256-GCM decrypt; fails if the data was tampered with or the key is wrong.
pub fn decrypt(key: &[u8; 32], blob: &[u8]) -> AppResult<Zeroizing<Vec<u8>>> {
    decrypt_aad(key, blob, b"")
}

pub fn decrypt_aad(key: &[u8; 32], blob: &[u8], aad: &[u8]) -> AppResult<Zeroizing<Vec<u8>>> {
    if blob.len() < NONCE_LEN {
        return Err(AppError::Crypto);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| AppError::Crypto)?;
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| AppError::Crypto)
}

/// Crockford base32: no I, L, O or U, so a key written down by hand can't be misread.
const RECOVERY_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A 256-bit key as groups of 4 characters, for writing down.
pub fn recovery_encode(key: &[u8; 32]) -> String {
    let mut chars = Vec::with_capacity(52);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in key {
        acc = (acc << 8) | *b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            chars.push(RECOVERY_ALPHABET[((acc >> bits) & 31) as usize] as char);
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        chars.push(RECOVERY_ALPHABET[((acc << (5 - bits)) & 31) as usize] as char);
    }
    chars.chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-")
}

/// Forgiving of case, spaces, dashes and the usual look-alike characters.
pub fn recovery_decode(text: &str) -> Option<Key> {
    let mut out = Zeroizing::new([0u8; 32]);
    let (mut acc, mut bits, mut n) = (0u32, 0u32, 0usize);
    for c in text.chars().filter(|c| !c.is_whitespace() && *c != '-') {
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        };
        let v = RECOVERY_ALPHABET.iter().position(|a| *a as char == c)? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if n == 32 {
                return None;
            }
            out[n] = (acc >> bits) as u8;
            acc &= (1 << bits) - 1;
            n += 1;
        }
    }
    (n == 32).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_key_roundtrip() {
        let key = random_key();
        let text = recovery_encode(&key);
        assert_eq!(*recovery_decode(&text).unwrap(), *key);
        assert_eq!(*recovery_decode(&text.to_lowercase().replace('-', " ")).unwrap(), *key);
        assert!(recovery_decode("ABCD").is_none());
        assert!(recovery_decode(&format!("{text}AAAA")).is_none());
        assert!(recovery_decode("!!!!").is_none());
    }

    #[test]
    fn roundtrip_and_tamper() {
        let key = random_key();
        let blob = encrypt(&key, b"dear diary").unwrap();
        assert_eq!(&decrypt(&key, &blob).unwrap()[..], b"dear diary");
        let mut bad = blob.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(decrypt(&key, &bad).is_err());
        assert!(decrypt(&random_key(), &blob).is_err());
    }

    #[test]
    fn aad_must_match() {
        let key = random_key();
        let blob = encrypt_aad(&key, b"entry", b"2026-10-14").unwrap();
        assert!(decrypt_aad(&key, &blob, b"2026-10-14").is_ok());
        assert!(decrypt_aad(&key, &blob, b"2026-10-15").is_err());
    }

    #[test]
    fn password_hash_verifies() {
        let phc = hash_password("correct horse").unwrap();
        assert!(verify_password("correct horse", &phc));
        assert!(!verify_password("wrong", &phc));
    }

    #[test]
    fn kek_is_deterministic() {
        let salt = random_bytes::<16>();
        assert_eq!(*derive_kek("pw", &salt).unwrap(), *derive_kek("pw", &salt).unwrap());
    }
}
