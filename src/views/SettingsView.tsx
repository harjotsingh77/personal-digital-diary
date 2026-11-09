import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Bell, BookText, Palette, Check, Copy, Download, Fingerprint, FolderOpen, FolderSync, KeyRound, LifeBuoy, LoaderCircle, PenLine, TriangleAlert, Upload } from "lucide-react";
import { api, errorMessage, type AutoBackupInfo, type ImportResult } from "../lib/api";
import { addDays, todayISO } from "../lib/dates";
import { printBook } from "../lib/printBook";
import { biometricName, device, isIOS } from "../lib/platform";
import {
  ACCENT_COLOURS, applyPageFont, DEFAULT_COLOURS, isDark, loadColours, PAGE_COLOURS, pageFont, saveColours,
  setTranscriptionLanguage, transcriptionLanguage, TRANSCRIPTION_LANGUAGES,
  type Colours, type PageFont, type Swatch, type ThemeMode,
} from "../lib/preferences";

interface Props {
  /** Called after an import so other views/stats refresh. */
  onDataChanged: () => void;
}

export function SettingsView({ onDataChanged }: Props) {
  return (
    <div className="flex h-full flex-col">
      <header data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[640px] space-y-5 px-10 pb-24 max-sm:px-4">
          <h1 className="font-serif text-[30px] text-ink">Settings</h1>
          <ColourSection />
          <PageSection />
          <ReminderSection />
          <SecuritySection />
          <ChangePasswordSection />
          <RecoverySection />
          <BackupSection onDataChanged={onDataChanged} />
          <AutoBackupSection />
          {!isIOS && <BookSection />}
          <AboutSection />
        </div>
      </div>
    </div>
  );
}

function Card({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="mb-4 flex items-center gap-2 text-[15px] font-medium text-ink">
        <span className="text-accent">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Button({ children, busy, variant = "primary", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; variant?: "primary" | "ghost" }) {
  return (
    <button
      {...rest}
      disabled={busy || rest.disabled}
      className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-medium transition active:scale-[0.98] disabled:opacity-60 ${
        variant === "primary" ? "bg-accent text-white hover:brightness-105" : "border border-line text-ink hover:bg-ink/5"
      }`}
    >
      {busy && <LoaderCircle size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

function Message({ kind, text }: { kind: "ok" | "error"; text: string }) {
  return (
    <p className={`mt-3 flex animate-fade-in items-start gap-1.5 text-[13px] ${kind === "ok" ? "text-accent" : "text-danger"}`}>
      {kind === "ok" ? <Check size={14} className="mt-0.5 shrink-0" /> : <TriangleAlert size={14} className="mt-0.5 shrink-0" />}
      {text}
    </p>
  );
}

/** On the iPhone, exports go to the app's folder in the Files app. */
function savedWhere(path: string): string {
  return isIOS ? `Files → On My ${device} → Diary (${path.split("/").pop()})` : path;
}

function SecuritySection() {
  const [bio, setBio] = useState<{ available: boolean; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => { api.biometricStatus().then(setBio).catch(() => {}); }, []);

  async function toggle() {
    if (!bio) return;
    setBusy(true);
    setMsg(null);
    try {
      if (bio.enabled) await api.disableTouchId();
      else await api.enableTouchId();
      setBio({ ...bio, enabled: !bio.enabled });
      setMsg({ kind: "ok", text: bio.enabled ? `${biometricName} turned off. The Keychain copy of your key was deleted.` : `${biometricName} is on.` });
    } catch (e) {
      setMsg({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Security" icon={<Fingerprint size={17} />}>
      <div className="flex items-start justify-between gap-6">
        <div>
          <p className="text-[14px] text-ink">Unlock with {biometricName}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            {bio && !bio.available
              ? `${biometricName} isn't available on this ${device} (or isn't set up).`
              : `Keeps a copy of your diary key in your ${device}'s Keychain, released only after a ${biometricName} check. Convenient, but it means anyone who can pass ${biometricName} on this ${device} can open the diary, not just your diary password.`}
          </p>
        </div>
        <Toggle on={!!bio?.enabled} disabled={!bio?.available || busy} onClick={toggle} label={`Unlock with ${biometricName}`} />
      </div>
      <div className="mt-4 border-t border-line pt-4 text-[12.5px] leading-relaxed text-muted">
        The diary locks itself after <span className="text-ink">5 minutes</span> without activity. Press{" "}
        <kbd className="rounded border border-line px-1 text-[11px]">⌘L</kbd> to lock it any time.
      </div>
      {msg && <Message {...msg} />}
    </Card>
  );
}

function Toggle({ on, disabled, onClick, label }: { on: boolean; disabled?: boolean; onClick: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40 ${on ? "bg-accent" : "bg-ink/15"}`}
    >
      <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200 ${on ? "translate-x-4" : ""}`} />
    </button>
  );
}

function ChangePasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next.length < 6) return setMsg({ kind: "error", text: "The new password needs at least 6 characters." });
    if (next !== confirm) return setMsg({ kind: "error", text: "The new passwords don't match." });
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent(""); setNext(""); setConfirm("");
      setMsg({ kind: "ok", text: "Password changed." });
    } catch (err) {
      setMsg({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded-lg border border-line bg-paper px-3 py-2 text-[13.5px] text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10";
  return (
    <Card title="Change password" icon={<KeyRound size={17} />}>
      <form onSubmit={submit} className="space-y-2.5">
        <input type="password" autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} aria-label="Current password" />
        <div className="grid grid-cols-2 gap-2.5">
          <input type="password" autoComplete="new-password" placeholder="New password" value={next} onChange={(e) => setNext(e.target.value)} className={input} aria-label="New password" />
          <input type="password" autoComplete="new-password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} aria-label="Confirm new password" />
        </div>
        <div className="pt-1">
          <Button type="submit" busy={busy} disabled={!current || !next}>Change password</Button>
        </div>
      </form>
      {msg && <Message {...msg} />}
    </Card>
  );
}

const fieldClass = "w-full rounded-lg border border-line bg-paper px-3 py-2 text-[13.5px] text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10";
const smallFieldClass = "rounded-lg border border-line bg-paper px-2 py-1.5 text-[13px] text-ink outline-none transition focus:border-accent";
type Msg = { kind: "ok" | "error"; text: string } | null;

function ColourSection() {
  const [colours, setColours] = useState<Colours>(loadColours);
  const change = (patch: Partial<Colours>) => {
    const next = { ...colours, ...patch };
    setColours(next);
    saveColours(next);
  };
  const dark = isDark(colours.mode);
  const modes: [ThemeMode, string][] = [["system", `Same as ${device}`], ["light", "Light"], ["dark", "Dark"]];
  const isDefault = colours.mode === DEFAULT_COLOURS.mode && colours.page === DEFAULT_COLOURS.page && colours.accent === DEFAULT_COLOURS.accent;

  return (
    <Card title="Colours" icon={<Palette size={17} />}>
      <div className="flex items-center justify-between gap-6">
        <p className="text-[14px] text-ink">Appearance</p>
        <div className="flex gap-1" role="radiogroup" aria-label="Appearance">
          {modes.map(([id, label]) => (
            <button
              key={id}
              role="radio"
              aria-checked={colours.mode === id}
              onClick={() => change({ mode: id })}
              className={`rounded-lg border px-3 py-1 text-[13px] transition ${colours.mode === id ? "border-accent bg-accent-soft text-accent" : "border-line text-ink hover:bg-ink/5"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <SwatchRow label="Pages" swatches={PAGE_COLOURS} value={colours.page} dark={dark} onChange={(page) => change({ page })} />
      <SwatchRow label="Accent" swatches={ACCENT_COLOURS} value={colours.accent} dark={dark} onChange={(accent) => change({ accent })} />
      {!isDefault && (
        <button onClick={() => { setColours(DEFAULT_COLOURS); saveColours(DEFAULT_COLOURS); }} className="mt-4 text-[12.5px] text-muted underline underline-offset-4 transition hover:text-ink">
          Back to the original colours
        </button>
      )}
    </Card>
  );
}

function SwatchRow({ label, swatches, value, dark, onChange }: { label: string; swatches: Swatch[]; value: string; dark: boolean; onChange: (v: string) => void }) {
  const custom = value.startsWith("#");
  const shown = (s: Swatch) => (dark ? s.dark : s.light);
  const dot = "relative flex size-7 items-center justify-center rounded-full ring-1 ring-ink/15 transition active:scale-95";
  return (
    <div className="mt-4 flex items-center justify-between gap-6">
      <p className="text-[14px] text-ink">{label}</p>
      <div className="flex items-center gap-2" role="radiogroup" aria-label={label}>
        {swatches.map((s) => (
          <button
            key={s.id}
            role="radio"
            aria-checked={value === s.id}
            aria-label={s.label}
            title={s.label}
            onClick={() => onChange(s.id)}
            style={{ background: shown(s) }}
            className={`${dot} ${value === s.id ? "ring-2 ring-offset-2 ring-offset-surface !ring-accent" : ""}`}
          />
        ))}
        <label
          title="Pick your own colour"
          style={custom ? { background: value } : { background: "conic-gradient(#d9605a, #d9b35a, #6fae6f, #5a9ad9, #a76fd0, #d9605a)" }}
          className={`${dot} cursor-pointer overflow-hidden ${custom ? "ring-2 ring-offset-2 ring-offset-surface !ring-accent" : ""}`}
        >
          <input
            type="color"
            aria-label={`Pick your own ${label.toLowerCase()} colour`}
            value={custom ? value : shown(swatches.find((s) => s.id === value) ?? swatches[0])}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      </div>
    </div>
  );
}

function PageSection() {
  const [font, setFont] = useState<PageFont>(pageFont);
  const [language, setLanguage] = useState(transcriptionLanguage);
  const choose = (f: PageFont) => { setFont(f); applyPageFont(f); };
  return (
    <Card title="Your pages" icon={<PenLine size={17} />}>
      <div className="flex items-center justify-between gap-6">
        <p className="text-[14px] text-ink">Writing style</p>
        <div className="flex gap-1" role="radiogroup" aria-label="Writing style">
          {([["hand", "Handwritten", "font-hand"], ["serif", "Book", "font-serif"]] as const).map(([id, label, cls]) => (
            <button
              key={id}
              role="radio"
              aria-checked={font === id}
              onClick={() => choose(id)}
              className={`rounded-lg border px-3 py-1 text-[14px] transition ${cls} ${font === id ? "border-accent bg-accent-soft text-accent" : "border-line text-ink hover:bg-ink/5"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 border-t border-line pt-4">
        <div className="flex items-center justify-between gap-6">
          <label htmlFor="speech-language" className="text-[14px] text-ink">Voice note language</label>
          <select id="speech-language" value={language} onChange={(e) => { setLanguage(e.target.value); setTranscriptionLanguage(e.target.value); }} className={smallFieldClass}>
            {TRANSCRIPTION_LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          "Turn into text" runs on this {device}, and never uses the network. While it works, the note's audio is briefly unencrypted in the diary's folder, then deleted.
        </p>
      </div>
    </Card>
  );
}

function ReminderSection() {
  const [time, setTime] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => { api.getReminder().then((t) => { setTime(t); setLoaded(true); }).catch(() => setLoaded(true)); }, []);

  async function apply(next: string | null) {
    setMsg(null);
    const before = time;
    setTime(next);
    try {
      await api.setReminder(next);
    } catch (e) {
      setTime(before);
      setMsg({ kind: "error", text: errorMessage(e) });
    }
  }

  return (
    <Card title="Daily reminder" icon={<Bell size={17} />}>
      <div className="flex items-center justify-between gap-6">
        <p className="text-[12.5px] leading-relaxed text-muted">
          A quiet notification, even when the app is closed. It never shows anything from your diary. It may appear under Script Editor in System Settings → Notifications.
        </p>
        <div className="flex shrink-0 items-center gap-3">
          {time && <input type="time" value={time} onChange={(e) => e.target.value && apply(e.target.value)} className={smallFieldClass} aria-label="Reminder time" />}
          <Toggle on={!!time} disabled={!loaded} onClick={() => apply(time ? null : "21:30")} label="Daily reminder" />
        </div>
      </div>
      {msg && <Message {...msg} />}
    </Card>
  );
}

function RecoverySection() {
  const [has, setHas] = useState(false);
  const [password, setPassword] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => { api.hasRecoveryKey().then(setHas).catch(() => {}); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      setKey(await api.createRecoveryKey(password));
      setHas(true);
      setPassword("");
    } catch (err) {
      setMsg({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Recovery key" icon={<LifeBuoy size={17} />}>
      <p className="text-[12.5px] leading-relaxed text-muted">
        {has
          ? "You have a recovery key. Making a new one stops the old one from working."
          : `You don't have a recovery key, so a forgotten password would lose your diary for good. Make one and keep it away from this ${device}.`}
      </p>
      {key ? (
        <div className="mt-3 animate-fade-in">
          <p className="break-words rounded-lg border border-line bg-paper p-3 text-center font-mono text-[13px] leading-relaxed text-ink [user-select:text]">{key}</p>
          <p className="mt-2 flex items-center justify-between text-[12.5px] text-muted">
            This won't be shown again.
            <button onClick={() => navigator.clipboard.writeText(key).then(() => setCopied(true))} className="flex items-center gap-1 transition hover:text-ink">
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
            </button>
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-3 flex gap-2">
          <input type="password" autoComplete="current-password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} className={fieldClass} aria-label="Your password" />
          <div className="shrink-0"><Button type="submit" busy={busy} disabled={!password}>{has ? "Make a new one" : "Make a key"}</Button></div>
        </form>
      )}
      {msg && <Message {...msg} />}
    </Card>
  );
}

function BackupSection({ onDataChanged }: { onDataChanged: () => void }) {
  const [busy, setBusy] = useState<"export" | "plain" | "import" | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [password, setPassword] = useState("");
  const [includeVideos, setIncludeVideos] = useState(true);
  const [importing, setImporting] = useState<string | null>(null);
  const [importPassword, setImportPassword] = useState("");

  const describeImport = (r: Pick<ImportResult, "imported" | "skipped">) =>
    `Imported ${r.imported} ${r.imported === 1 ? "page" : "pages"}${r.skipped ? ` · skipped ${r.skipped} already up to date` : ""}.`;

  async function doExport() {
    setBusy("export"); setMsg(null);
    try {
      const path = await api.exportEncryptedBackup(todayISO(), password, includeVideos);
      if (path) { setMsg({ kind: "ok", text: `Encrypted backup saved to ${savedWhere(path)}` }); setPassword(""); }
    } catch (e) {
      setMsg({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function doPlainExport() {
    setBusy("plain"); setMsg(null);
    try {
      const path = await api.exportBackup(todayISO());
      if (path) setMsg({ kind: "ok", text: `Unencrypted backup saved to ${savedWhere(path)}. It doesn't include videos.` });
    } catch (e) {
      setMsg({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function doImport() {
    setBusy("import"); setMsg(null);
    try {
      const r = await api.importBackup();
      if (r?.needsPassword) setImporting(r.needsPassword);
      else if (r) {
        setMsg({ kind: "ok", text: describeImport({ imported: r.imported ?? 0, skipped: r.skipped ?? 0 }) });
        onDataChanged();
      }
    } catch (e) {
      setMsg({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function finishImport(e: FormEvent) {
    e.preventDefault();
    if (!importing) return;
    setBusy("import"); setMsg(null);
    try {
      setMsg({ kind: "ok", text: describeImport(await api.importEncryptedBackup(importing, importPassword)) });
      setImporting(null);
      setImportPassword("");
      onDataChanged();
    } catch (err) {
      setMsg({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Backup" icon={<Download size={17} />}>
      <p className="text-[12.5px] leading-relaxed text-muted">
        Saves everything to one file, locked with its own password. Importing merges: for each day, the most recently edited version is kept. Without this password, the backup can't be opened.
      </p>
      <div className="mt-3 flex gap-2">
        <input type="password" autoComplete="new-password" placeholder="Backup password" value={password} onChange={(e) => setPassword(e.target.value)} className={fieldClass} aria-label="Backup password" />
        <div className="shrink-0"><Button onClick={doExport} busy={busy === "export"} disabled={!!busy || password.length < 6}><Download size={14} /> Export…</Button></div>
      </div>
      <label className="mt-2 flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={includeVideos} onChange={(e) => setIncludeVideos(e.target.checked)} className="accent-[var(--accent)]" />
        Include videos (can make the file very large)
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4">
        <Button variant="ghost" onClick={doImport} busy={busy === "import" && !importing} disabled={!!busy}><Upload size={14} /> Import…</Button>
        <button onClick={doPlainExport} disabled={!!busy} className="flex items-center gap-1.5 text-[12.5px] text-muted underline-offset-4 transition hover:text-ink hover:underline disabled:opacity-60">
          {busy === "plain" && <LoaderCircle size={13} className="animate-spin" />}
          Export unencrypted JSON (no videos; anyone can read it)
        </button>
      </div>

      {importing && (
        <form onSubmit={finishImport} className="mt-3 flex animate-fade-in gap-2">
          <input autoFocus type="password" autoComplete="off" placeholder="This backup's password" value={importPassword} onChange={(e) => setImportPassword(e.target.value)} className={fieldClass} aria-label="This backup's password" />
          <div className="shrink-0"><Button type="submit" busy={busy === "import"} disabled={!importPassword}>Import</Button></div>
        </form>
      )}
      {msg && <Message {...msg} />}
    </Card>
  );
}

function AutoBackupSection() {
  const [info, setInfo] = useState<AutoBackupInfo | null>(null);
  const [password, setPassword] = useState("");
  const [everyDays, setEveryDays] = useState(7);
  const [includeVideos, setIncludeVideos] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const load = () => api.getAutoBackup().then(setInfo).catch(() => {});
  useEffect(() => { load(); }, []);
  // A backup runs in the background; refresh its status until it's done.
  useEffect(() => {
    if (!info?.running) return;
    const id = window.setInterval(load, 2000);
    return () => window.clearInterval(id);
  }, [info?.running]);

  async function enable(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      if (await api.enableAutoBackup(password, everyDays, includeVideos)) {
        setPassword("");
        await api.runAutoBackup(todayISO(), true);
        await load();
      }
    } catch (err) {
      setMsg({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setMsg(null);
    try {
      await api.runAutoBackup(todayISO(), true);
      await load();
    } catch (err) {
      setMsg({ kind: "error", text: errorMessage(err) });
    }
  }

  async function disable() {
    setMsg(null);
    try {
      await api.disableAutoBackup();
      setInfo(null);
    } catch (err) {
      setMsg({ kind: "error", text: errorMessage(err) });
    }
  }

  return (
    <Card title="Automatic backups" icon={<FolderSync size={17} />}>
      {info ? (
        <>
          <p className="text-[12.5px] leading-relaxed text-muted">
            Every {info.everyDays === 1 ? "day" : `${info.everyDays} days`}, while the diary is unlocked, an encrypted backup goes to the folder below. The newest 3 are kept.
          </p>
          <p className="mt-2 truncate rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[11.5px] text-ink/70" title={info.folder}>{info.folder}</p>
          <p className="mt-2 text-[12.5px] text-muted">
            {info.running ? "Backing up now…" : info.lastRun ? `Last backup: ${info.lastRun}` : "No backup yet."}
          </p>
          {info.lastError && !info.running && <Message kind="error" text={`The last backup failed: ${info.lastError}`} />}
          <div className="mt-3 flex gap-2">
            <Button variant="ghost" onClick={runNow} disabled={info.running}>Back up now</Button>
            <Button variant="ghost" onClick={disable}>Turn off</Button>
          </div>
        </>
      ) : (
        <form onSubmit={enable}>
          <p className="text-[12.5px] leading-relaxed text-muted">
            {isIOS
              ? "Keeps encrypted copies in the Files app, under On My iPhone → Diary → Backups. Backups only run while the diary is unlocked."
              : "Keeps encrypted copies in a folder you choose, like an external drive. Backups only run while the diary is unlocked."}
          </p>
          <input type="password" autoComplete="new-password" placeholder="Password for these backups" value={password} onChange={(e) => setPassword(e.target.value)} className={`${fieldClass} mt-3`} aria-label="Password for these backups" />
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink">
            <label className="flex items-center gap-2">
              Every
              <select value={everyDays} onChange={(e) => setEveryDays(Number(e.target.value))} className={smallFieldClass}>
                <option value={1}>day</option>
                <option value={7}>week</option>
                <option value={30}>month</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeVideos} onChange={(e) => setIncludeVideos(e.target.checked)} className="accent-[var(--accent)]" />
              Include videos
            </label>
          </div>
          <div className="mt-3"><Button type="submit" busy={busy} disabled={password.length < 6}><FolderOpen size={14} /> {isIOS ? "Turn on" : "Choose folder…"}</Button></div>
        </form>
      )}
      {msg && <Message {...msg} />}
    </Card>
  );
}

function BookSection() {
  const today = todayISO();
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function make() {
    setBusy(true); setMsg(null);
    try {
      const n = await printBook(from, to);
      if (n === 0) setMsg({ kind: "error", text: "Nothing is written in those dates." });
    } catch (e) {
      setMsg({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Make a book (PDF)" icon={<BookText size={17} />}>
      <p className="text-[12.5px] leading-relaxed text-muted">
        Lays out your pages with their photos and opens the print window. Choose PDF → Save as PDF there. The file isn't encrypted.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-ink">
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={smallFieldClass} aria-label="From" />
        to
        <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className={smallFieldClass} aria-label="To" />
        <Button onClick={make} busy={busy} disabled={!from || !to}>Make book…</Button>
      </div>
      {msg && <Message {...msg} />}
    </Card>
  );
}

function AboutSection() {
  const [path, setPath] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.dataLocation().then(setPath).catch(() => {}); }, []);
  return (
    <Card title="Your data" icon={<FolderOpen size={17} />}>
      <p className="text-[12.5px] leading-relaxed text-muted">
        Everything stays on this {device}. Nothing is sent anywhere: no cloud, no analytics, no network. Entries, photos, voice and video notes are encrypted with AES-256-GCM using a key derived from your password (Argon2id).
      </p>
      <button
        onClick={() => { navigator.clipboard.writeText(path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
        title="Copy path"
        className="mt-3 w-full truncate rounded-lg border border-line bg-paper px-3 py-2 text-left font-mono text-[11.5px] text-ink/70 transition hover:border-accent"
      >
        {copied ? "Copied ✓" : path}
      </button>
      {!isIOS && (
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 border-t border-line pt-4 text-[12.5px] text-muted">
        {[
          ["⌘N", "Write today"], ["⌘F", "Search"], ["⌘L", "Lock"], ["⌘1–7", "Switch view"], ["⌘[ / ⌘]", "Turn page"],
          ["⌘B / ⌘I", "Bold / italic"], ["⌘⇧9", "Checklist"],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between"><span>{v}</span><kbd className="text-ink/70">{k}</kbd></div>
        ))}
      </div>
      )}
    </Card>
  );
}
