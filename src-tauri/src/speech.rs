//! Voice note transcription through macOS's Speech framework, forced to run
//! on-device so the app's promise of no network use still holds. If a language
//! has no on-device model this fails instead of falling back to Apple's servers.
//!
//! The framework reads from a file, so the decrypted audio exists on disk in
//! the app's private folder for as long as recognition takes, and is deleted
//! right after. The Settings screen says so.

use std::path::Path;

use crate::error::{AppError, AppResult};

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use block2::RcBlock;
    use objc2::AnyThread;
    use objc2_foundation::{NSError, NSLocale, NSString, NSURL};
    use objc2_speech::{
        SFSpeechRecognitionResult, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
        SFSpeechURLRecognitionRequest,
    };
    use std::sync::mpsc;
    use std::time::Duration;

    /// Recognition runs at about real time or better; notes can be long.
    const TIMEOUT: Duration = Duration::from_secs(30 * 60);

    fn ensure_authorized() -> AppResult<()> {
        let (tx, rx) = mpsc::channel();
        let reply = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
            let _ = tx.send(status);
        });
        unsafe { SFSpeechRecognizer::requestAuthorization(&reply) };
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(SFSpeechRecognizerAuthorizationStatus::Authorized) => Ok(()),
            _ => Err(AppError::Invalid(
                "Speech recognition is off. Allow Diary in System Settings → Privacy & Security → Speech Recognition.".into(),
            )),
        }
    }

    pub fn recognize(file: &Path, language: &str) -> AppResult<String> {
        ensure_authorized()?;
        let path = file.to_str().ok_or_else(|| AppError::Internal("Bad temp path".into()))?;
        let (tx, rx) = mpsc::channel::<AppResult<String>>();
        // Kept alive until recognition ends; dropping the task would cancel it.
        let _task = unsafe {
            let locale = NSLocale::localeWithLocaleIdentifier(&NSString::from_str(language));
            let recognizer = SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale)
                .ok_or_else(|| AppError::Invalid(format!("This Mac can't recognise {language}")))?;
            if !recognizer.supportsOnDeviceRecognition() {
                return Err(AppError::Invalid(format!(
                    "No on-device speech model for {language}. Turn on Dictation for it in System Settings → Keyboard, then try again."
                )));
            }
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let request = SFSpeechURLRecognitionRequest::initWithURL(SFSpeechURLRecognitionRequest::alloc(), &url);
            request.setRequiresOnDeviceRecognition(true);
            request.setShouldReportPartialResults(false);
            request.setAddsPunctuation(true);
            let handler = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                if !error.is_null() {
                    let _ = tx.send(Err(AppError::Invalid(
                        "Couldn't make out any words in this note".into(),
                    )));
                } else if let Some(result) = result.as_ref() {
                    if result.isFinal() {
                        let _ = tx.send(Ok(result.bestTranscription().formattedString().to_string()));
                    }
                }
            });
            (recognizer.clone(), recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler))
        };
        rx.recv_timeout(TIMEOUT).map_err(|_| AppError::Invalid("Transcription took too long".into()))?
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;
    pub fn recognize(_: &Path, _: &str) -> AppResult<String> {
        Err(AppError::Invalid("Transcription is only available on macOS".into()))
    }
}

/// Blocks until done, so it must run off the main thread.
pub fn transcribe(data_dir: &Path, id: &str, audio: &[u8], language: &str) -> AppResult<String> {
    crate::attachments::validate_id(id)?;
    if !language.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::Invalid("Invalid language".into()));
    }
    let tmp = data_dir.join(format!("transcribing-{id}.m4a"));
    std::fs::write(&tmp, audio).map_err(|e| AppError::Internal(e.to_string()))?;
    let result = imp::recognize(&tmp, language);
    let _ = std::fs::remove_file(&tmp);
    result
}
