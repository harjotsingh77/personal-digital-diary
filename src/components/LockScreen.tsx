import { FormEvent, useEffect, useRef, useState } from "react";
import { Check, Copy, Fingerprint, LoaderCircle } from "lucide-react";
import { api, errorMessage } from "../lib/api";

interface Props {
  /** "setup" on first launch (no password yet), otherwise "unlock". */
  mode: "setup" | "unlock";
  /** Offer Touch ID (it's turned on and available). */
  touchId?: boolean;
  /** The diary has a recovery key, so a forgotten password isn't the end. */
  hasRecovery?: boolean;
  onUnlocked: () => void;
}

const MIN_LEN = 6;

export function LockScreen({ mode, touchId, hasRecovery, onUnlocked }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  /** A freshly made recovery key, shown once right after creating the diary. */
  const [newKey, setNewKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  async function unlockWithTouchId() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.unlockWithTouchId();
      onUnlocked();
    } catch (err) {
      setError(errorMessage(err));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  // Prompt for Touch ID straight away when it's turned on (once — React's
  // StrictMode runs effects twice in development).
  const prompted = useRef(false);
  useEffect(() => {
    if (mode === "unlock" && touchId && !prompted.current) {
      prompted.current = true;
      unlockWithTouchId();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fail = (msg: string) => {
    setError(msg);
    setShakeKey((k) => k + 1); // re-trigger the shake animation
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (recovering) {
      if (password.length < MIN_LEN) return fail(`Use at least ${MIN_LEN} characters.`);
      if (password !== confirm) return fail("The passwords don't match.");
      setBusy(true);
      try {
        await api.recoverWithKey(recoveryInput, password);
        onUnlocked();
      } catch (err) {
        fail(errorMessage(err));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (mode === "setup") {
      if (password.length < MIN_LEN) return fail(`Use at least ${MIN_LEN} characters.`);
      if (password !== confirm) return fail("The passwords don't match.");
    } else if (!password) {
      return;
    }

    setBusy(true);
    try {
      if (mode === "setup") {
        await api.setupPassword(password);
        const key = await api.createRecoveryKey(password);
        setPassword("");
        setConfirm("");
        setNewKey(key); // onUnlocked waits until the key has been seen
        return;
      }
      await api.unlock(password);
      setPassword("");
      setConfirm("");
      onUnlocked();
    } catch (err) {
      fail(errorMessage(err));
      setPassword("");
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const heading = recovering ? "Recover your diary" : mode === "setup" ? "My Diary" : "Diary";
  const showConfirm = mode === "setup" || recovering;

  if (newKey) return <RecoveryKeyShown recoveryKey={newKey} onDone={onUnlocked} />;

  return (
    <div className="desk relative flex h-full items-center justify-center">
      {/* Invisible strip so the window can be dragged by its top edge. */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-12" />

      <form onSubmit={submit} className="cover animate-cover-open text-center">
        <h1 className="font-hand text-[40px] leading-tight text-[#f6ecdc]">{heading}</h1>
        <p className="mb-8 mt-2 text-[13px] leading-relaxed text-[#efe3d0]/70">
          {recovering
            ? "Enter your recovery key and choose a new password."
            : mode === "setup"
              ? "Choose a password. It locks everything you write."
              : "Private. Only yours."}
        </p>

        <div key={shakeKey} className={`space-y-2 ${shakeKey ? "animate-shake" : ""}`}>
          {recovering && (
            <textarea
              value={recoveryInput}
              onChange={(e) => setRecoveryInput(e.target.value)}
              rows={2}
              placeholder="Recovery key"
              autoFocus
              disabled={busy}
              className="cover-input resize-none font-mono !text-[13px]"
              aria-label="Recovery key"
            />
          )}
          <input
            ref={inputRef}
            type="password"
            autoComplete={showConfirm ? "new-password" : "current-password"}
            placeholder={showConfirm ? "New password" : "Password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="cover-input"
            aria-label={showConfirm ? "New password" : "Password"}
          />
          {showConfirm && (
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              className="cover-input"
              aria-label="Confirm password"
            />
          )}
        </div>

        <p className="mt-3 min-h-5 text-[13px] text-[#f0a79f]" role="alert">{error}</p>

        <button
          type="submit"
          disabled={busy}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-[#e8c99e] px-4 py-2.5 text-[14px] font-medium text-[#3a2419] transition hover:brightness-105 active:scale-[0.99] disabled:opacity-70"
        >
          {busy && <LoaderCircle size={15} className="animate-spin" />}
          {recovering ? "Recover and open" : mode === "setup" ? "Start writing" : "Open"}
        </button>

        {mode === "unlock" && touchId && !recovering && (
          <button
            type="button"
            onClick={unlockWithTouchId}
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-[13.5px] text-[#efe3d0] transition hover:bg-white/5 disabled:opacity-60"
          >
            <Fingerprint size={16} />
            Use Touch ID
          </button>
        )}

        {mode === "unlock" && hasRecovery && (
          <button
            type="button"
            onClick={() => { setRecovering(!recovering); setError(null); setPassword(""); setConfirm(""); }}
            className="mt-3 text-[12px] text-[#efe3d0]/60 underline-offset-4 transition hover:text-[#efe3d0] hover:underline"
          >
            {recovering ? "Back" : "Forgot your password?"}
          </button>
        )}
      </form>
    </div>
  );
}

/** Shown once. Without it, a forgotten password means losing everything. */
export function RecoveryKeyShown({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="desk flex h-full items-center justify-center p-6">
      <div className="w-[460px] animate-rise rounded-md bg-[var(--page)] p-8 shadow-[0_24px_50px_-16px_var(--shadow)]">
        <h1 className="font-hand text-[26px] text-ink">Your recovery key</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
          If you ever forget your password, this is the only way back in. Write it down and keep it away from this Mac. It won't be shown again.
        </p>
        <p className="mt-5 select-text break-words rounded-md border border-line bg-surface p-4 text-center font-mono text-[14px] leading-relaxed text-ink [user-select:text]">{recoveryKey}</p>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(recoveryKey).then(() => setCopied(true))}
          className="mt-2 flex items-center gap-1.5 text-[12.5px] text-muted transition hover:text-ink"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
        <label className="mt-5 flex items-center gap-2 text-[13.5px] text-ink">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="accent-[var(--accent)]" />
          I've saved it somewhere safe
        </label>
        <button
          type="button"
          disabled={!saved}
          onClick={onDone}
          className="mt-4 w-full rounded-md bg-accent px-4 py-2.5 text-[14px] font-medium text-white transition hover:brightness-105 active:scale-[0.99] disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
