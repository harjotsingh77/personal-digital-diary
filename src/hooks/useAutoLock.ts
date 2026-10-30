import { useEffect, useRef } from "react";

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;

/** Things that count as activity without any input (e.g. recording a voice note). */
let holds = 0;
export function holdAutoLock(): () => void {
  holds++;
  let released = false;
  return () => { if (!released) { released = true; holds--; } };
}

/**
 * Calls `onIdle` after `timeoutMs` without user input.
 *
 * Uses a "last activity" timestamp checked on an interval (and whenever the
 * window regains focus) rather than a single setTimeout, because macOS
 * throttles timers in background windows — this way the diary still locks
 * correctly if you return after the laptop has been asleep.
 */
export function useAutoLock(enabled: boolean, timeoutMs: number, onIdle: () => void) {
  const lastActivity = useRef(Date.now());
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!enabled) return;
    lastActivity.current = Date.now();

    const bump = () => { lastActivity.current = Date.now(); };
    const check = () => {
      if (holds > 0) bump();
      else if (Date.now() - lastActivity.current >= timeoutMs) onIdleRef.current();
    };

    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    const id = window.setInterval(check, 10_000);

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, bump));
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(id);
    };
  }, [enabled, timeoutMs]);
}
