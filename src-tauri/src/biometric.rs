//! Touch ID unlock (macOS only, opt-in from Settings).
//!
//! How it works: when enabled, a copy of the data key is stored in the user's
//! login Keychain. Unlocking with Touch ID asks macOS LocalAuthentication to
//! verify your fingerprint, then reads the key back from the Keychain.
//!
//! Trade-off (shown in Settings): the password alone no longer protects the
//! key — anyone who can use your *unlocked Mac user account* and pass Touch ID
//! (or approve the Keychain prompt with your Mac login password) can open the
//! diary. Disabling Touch ID deletes the Keychain copy.

use crate::crypto::Key;
use crate::error::{AppError, AppResult};

const SERVICE: &str = "com.harjotsingh.diary";
const ACCOUNT: &str = "touch-id-data-key";

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::*;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::mpsc;
    use std::time::Duration;
    use zeroize::Zeroizing;

    /// Is Touch ID hardware present and enrolled?
    pub fn available() -> bool {
        unsafe {
            let ctx = LAContext::new();
            ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics).is_ok()
        }
    }

    /// Show the system Touch ID sheet. Blocks until the user responds, so it
    /// must be called off the main thread.
    pub fn authenticate(reason: &str) -> AppResult<()> {
        let (tx, rx) = mpsc::channel::<bool>();
        let reply = RcBlock::new(move |success: Bool, _err: *mut NSError| {
            let _ = tx.send(success.as_bool());
        });
        unsafe {
            let ctx = LAContext::new();
            ctx.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthenticationWithBiometrics,
                &NSString::from_str(reason),
                &reply,
            );
        }
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(true) => Ok(()),
            _ => Err(AppError::Invalid("Touch ID was cancelled or didn't match".into())),
        }
    }

    pub fn store_key(key: &Key) -> AppResult<()> {
        security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, key.as_ref())
            .map_err(|e| AppError::Internal(format!("Keychain: {e}")))
    }

    pub fn load_key() -> AppResult<Key> {
        let bytes = Zeroizing::new(
            security_framework::passwords::get_generic_password(SERVICE, ACCOUNT)
                .map_err(|_| AppError::Invalid("Touch ID key not found — please use your password".into()))?,
        );
        let arr: [u8; 32] = bytes[..].try_into().map_err(|_| AppError::Crypto)?;
        Ok(Zeroizing::new(arr))
    }

    pub fn delete_key() {
        let _ = security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT);
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod imp {
    use super::*;
    pub fn available() -> bool { false }
    pub fn authenticate(_: &str) -> AppResult<()> { Err(AppError::Invalid("Touch ID is only available on macOS".into())) }
    pub fn store_key(_: &Key) -> AppResult<()> { Err(AppError::Invalid("Unsupported".into())) }
    pub fn load_key() -> AppResult<Key> { Err(AppError::Invalid("Unsupported".into())) }
    pub fn delete_key() {}
}

pub use imp::*;
