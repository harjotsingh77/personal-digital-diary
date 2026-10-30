# Diary

A private, offline personal diary for macOS. Built with Tauri v2, React, TypeScript and Tailwind CSS.

- **100% offline.** It makes no network requests and has no analytics. Fonts are bundled, and the CSP blocks outside connections.
- **Encrypted.** Entry content is encrypted with AES-256-GCM. The key comes from your password via Argon2id.
- **Local.** All data stays in a SQLite database on your Mac.

## Features

- **A real book:** two facing pages on a desk, ruled lines, a handwritten font that also covers Hindi (or a book serif), and a page that physically turns (⌘[ and ⌘], or the page corners). The right page is the day you're writing; the left is the day before. When the window is narrow it becomes one page.
- **Just start writing:** no title or form. Today's page opens with the time written on it and the cursor ready. Coming back after 30 minutes starts a new time on the same page.
- **Lock screen:** a diary cover with an Argon2id password, optional Touch ID, auto-lock after 5 minutes, and ⌘L to lock right away.
- **Recovery key:** made when the diary is created, or in Settings. It's the only way back in if you forget your password.
- **Voice notes:** hold the mic and speak, or click once for hands-free. Notes play with a seekable waveform, and "Turn into text" transcribes them on this Mac only, so search can find what you said.
- **Video notes:** record from the camera right on the page, with no length limit. Frames go straight to disk, encrypted, as they're recorded.
- **Photos:** add with the button, by drag and drop, or by pasting. The Photos view collects them all.
- **On This Day:** a slip on today's spread showing the same date in past years and months.
- **Prompts and templates:** only on an empty page, and only if you click one.
- **Bookmarks:** the ribbon on a page marks it; Timeline can filter to bookmarked days.
- **Calendar, Timeline and search:** full-text search with `#tag`, mood, date range and bookmark filters. Search covers voice note transcripts.
- **Mood and Year in Review:** a monthly mood chart, and a whole-year view with a mood map, most-used tags, your longest page and your best run.
- **Daily reminder:** a notification at your chosen time, even with the app closed. It shows nothing from the diary.
- **Backups:** encrypted exports with their own password (videos optional), automatic encrypted backups to a folder, and an unencrypted JSON export without videos. Importing merges, and for each day the most recently edited version wins.
- **Make a book:** lay out a date range with photos and save it as a PDF from the print window.

## Download

Get the latest `.dmg` from the [Releases page](https://github.com/harjotsingh77/personal-digital-diary/releases/latest). It's built for Apple Silicon Macs (M1 or later) running macOS 12 or newer. On an Intel Mac, build it from source using the steps below.

The app isn't code-signed, so macOS blocks it the first time. Try to open it, then go to **System Settings → Privacy & Security** and click **Open Anyway**.

---

## 1. Install prerequisites (one time)

```bash
# Xcode Command Line Tools (compiler + macOS SDK)
xcode-select --install

# Rust (official installer), then reload your shell
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Node.js 20+ (pick one)
brew install node        # or download from https://nodejs.org
```

Check that everything is installed:

```bash
rustc -V && cargo -V && node -v && npm -v
```

## 2. Install dependencies

```bash
cd "personal digital diary"
npm install
```

## 3. Run in development mode

```bash
npm run tauri dev
```

The first run compiles all the Rust crates, which takes a few minutes. Later runs start in seconds. Frontend changes hot-reload, and Rust changes rebuild automatically.

## 4. Build the `.dmg` installer

```bash
npm run tauri build
```

The release build takes 2–3 minutes. When it finishes, the installer is at:

```
src-tauri/target/release/bundle/dmg/Diary_0.1.0_aarch64.dmg
```

On an Intel Mac the file is named `Diary_0.1.0_x64.dmg`. The plain app bundle is at `src-tauri/target/release/bundle/macos/Diary.app`.

> The app isn't code-signed. The first time you open it, right-click **Diary.app**, choose **Open**, then confirm.

---

## Where your data lives

```
~/Library/Application Support/com.harjotsingh.diary/diary.db
```

To start completely fresh, quit the app and delete that folder. **Without your password the data can't be recovered.**

## How the encryption works

What's encrypted: each entry's title, text, mood, tags, bookmark and its photo, voice-note and video-note lists, plus every photo, voice-note and video file. The only plaintext data is each entry's **date** and when it was created and last edited. Those are needed for the calendar and streak.


```
password ──Argon2id(64 MiB, 3 passes, random salt)──▶ KEK   (never stored)
KEK      ──AES-256-GCM──▶ wraps a random 256-bit DEK          (stored wrapped)
DEK      ──AES-256-GCM──▶ encrypts every entry, photo and voice note
```

- A separate Argon2id PHC hash is stored to check your password.
- The DEK exists in memory only while the diary is unlocked. Locking wipes it (`zeroize`).
- Changing your password only re-wraps the DEK, so entries never need to be re-encrypted.
- Each failed unlock attempt adds a short delay to slow down guessing.
- Each entry's ciphertext is tied to its date (AES-GCM associated data), so rows can't be swapped around. Photos and voice notes are tied to their kind and ID the same way.
- **Touch ID** is opt-in from Settings. It keeps a copy of the DEK in your macOS login Keychain, and the app only reads it after a successful fingerprint check. This is convenient, but it means anyone with access to your unlocked Mac account could also open the diary. Turning Touch ID off deletes the Keychain copy.
- **Videos** are sealed in 1 MiB AES-GCM frames, each bound to the video, its position and whether it's the last, so frames can't be reordered, swapped or cut off unnoticed. The player decrypts only the frames it needs, through a private `diaryvideo://` protocol that refuses to serve while the diary is locked.
- **Encrypted backups** use the same framing, under a key from their own password (Argon2id). Automatic backups keep that key encrypted under the data key, so they only run while the diary is unlocked.
- The **recovery key** is a random 256-bit key that wraps the data key. Only the wrapped copy is stored.
- The **JSON backup is not encrypted**, so anyone who can read the file can read your diary. A **PDF book** isn't either.
- **Transcription** uses macOS's on-device speech recognition and fails rather than using Apple's servers. While it runs, that note's audio is briefly unencrypted in the app's folder.
- The **reminder** is a launchd job at `~/Library/LaunchAgents/com.harjotsingh.diary.reminder.plist`. Turning it off removes it.

## Project structure

```
├── index.html, vite.config.ts, tsconfig.json
├── assets/app-icon.svg          # source for the app icon (npx tauri icon assets/app-icon.svg)
├── src/                         # React frontend
│   ├── main.tsx                 # entry, bundled fonts
│   ├── App.tsx                  # lock gate, auto-lock, layout
│   ├── styles.css               # Tailwind + warm light/dark design tokens
│   ├── lib/                     # api (typed Rust calls), dates, moods, photos, voice, saveRegistry
│   ├── hooks/                   # useAutoLock, useAutosave, usePhotoUrl
│   ├── components/              # LockScreen, Sidebar, MoodPicker, TagInput, PhotoStrip, VoiceRecorder, editor/ (incl. VoiceNoteNode)
│   ├── views/                   # Write, Calendar, Timeline, Mood, Settings
│   └── dev/mockBackend.ts       # browser-only fake backend for UI work (never shipped)
└── src-tauri/                   # Rust backend
    ├── tauri.conf.json          # window, CSP, bundle (.dmg) settings
    ├── Info.plist               # microphone permission text (voice notes)
    ├── capabilities/            # frontend permissions
    └── src/
        ├── lib.rs               # app setup + command registry
        ├── crypto.rs            # Argon2id + AES-256-GCM
        ├── db.rs                # SQLite open + migrations
        ├── entries.rs           # encrypted entry storage
        ├── search.rs            # full-text search + tag counts
        ├── stats.rs             # streaks
        ├── attachments.rs       # encrypted photo + voice-note files
        ├── backup.rs            # JSON export / import
        ├── biometric.rs         # Touch ID (LocalAuthentication) + Keychain
        ├── state.rs, error.rs
        └── commands/            # auth, entries, library, settings (the Tauri commands)
```

To run the Rust tests (covering crypto, storage, search, streaks, attachments, video, backups and reminders): `cd src-tauri && cargo test`

To work on the UI in a normal browser without Tauri, run `npm run dev` and open http://127.0.0.1:1420/?seed. A fake in-memory backend with sample entries takes over, and its password is `password`. This only happens in development and never reaches the built app.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘N | Write today's entry |
| ⌘F | Search |
| ⌘1 – ⌘7 | Diary / Calendar / Timeline / Photos / Mood / Year / Settings |
| ⌘[ / ⌘] | Turn to the previous / next page |
| ⌘L | Lock now |
| ⌘B / ⌘I / ⌘⇧S | Bold / italic / strikethrough |
| ⌘⌥1 / ⌘⌥2 | Heading / subheading |
| ⌘⇧8 / ⌘⇧7 / ⌘⇧9 | Bullet / numbered list / checklist |

## Roadmap

- [x] **Phase 1:** project setup and lock screen (Argon2 password, encryption key, 5-minute auto-lock)
- [x] **Phase 2:** rich-text editor and autosave to encrypted SQLite
- [x] **Phase 3:** calendar and timeline views
- [x] **Phase 4:** mood tracker, tags, search, photos, streak
- [x] **Phase 5:** UI polish, Touch ID, settings and JSON export/import, `.dmg` build
- [x] **Phase 6:** the book, video notes, transcription, recovery key, encrypted and automatic backups, reminder, On This Day, prompts, bookmarks, gallery, Year in Review, PDF book
