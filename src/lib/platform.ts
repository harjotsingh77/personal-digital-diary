/** Which Apple device the app runs on, for wording and the few features that differ. */

// iPadOS reports itself as a Mac, but a Mac has no touch points.
export const isIOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);

/** "this iPhone" / "this Mac" in sentences. */
export const device = isIOS ? (/iPad/.test(navigator.userAgent) || navigator.maxTouchPoints > 1 && !/iPhone/.test(navigator.userAgent) ? "iPad" : "iPhone") : "Mac";

/** Where people turn on camera / microphone access for the app. */
export const privacySettings = (what: "Camera" | "Microphone") =>
  isIOS ? `Allow Diary in Settings → Privacy & Security → ${what}.` : `Allow Diary in System Settings → Privacy & Security → ${what}.`;

/** The phone unlocks with Face ID; the Mac with Touch ID. */
export const biometricName = isIOS ? "Face ID" : "Touch ID";
