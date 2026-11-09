import { api, type VoiceNote } from "./api";
import { device, privacySettings } from "./platform";

/** WKWebView (the real app) records AAC in mp4; Chromium prefers WebM/Opus. */
const MIME_CANDIDATES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
/** How often the input level is sampled for the waveform. */
export const LEVEL_INTERVAL_MS = 50;
/** Bars in a saved note's waveform. */
const PEAK_BARS = 48;

export interface Recording {
  bytes: Uint8Array;
  mime: string;
  durationMs: number;
  recordedAt: number;
  peaks: number[];
}

/** Turn a getUserMedia / MediaRecorder failure into something a person can act on. */
function micError(e: unknown): Error {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error(`Microphone access is off. ${privacySettings("Microphone")}`);
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return new Error("No microphone found.");
  if (typeof MediaRecorder === "undefined") return new Error(`Voice recording isn't supported on this ${device}.`);
  return new Error("Couldn't start recording.");
}

/** Squash per-tick levels (0–1) into a fixed number of 0–100 bars. */
function toPeaks(levels: number[]): number[] {
  if (!levels.length) return [];
  const bars = Math.min(PEAK_BARS, levels.length);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i * levels.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / bars));
    out.push(Math.max(...levels.slice(from, to)));
  }
  // Normalise so quiet recordings still show their shape.
  const max = Math.max(...out, 0.05);
  return out.map((v) => Math.round(Math.max(6, (v / max) * 100)));
}

/**
 * One microphone recording. `levels` grows while recording (for the live
 * waveform); `stop()` resolves with the encoded audio, `cancel()` discards it.
 */
export class MicRecording {
  readonly levels: number[] = [];
  readonly startedAt = Date.now();
  private chunks: Blob[] = [];
  private timer: number | undefined;

  private constructor(
    private stream: MediaStream,
    private recorder: MediaRecorder,
    private ctx: AudioContext,
  ) {}

  static async start(): Promise<MicRecording> {
    // Created before the await so it counts as part of the click/press.
    const ctx = new AudioContext();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      ctx.close();
      throw micError(e);
    }
    try {
      const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const rec = new MicRecording(stream, recorder, ctx);
      rec.begin();
      return rec;
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      throw micError(e);
    }
  }

  private begin() {
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.start(1000);

    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(analyser);
    this.ctx.resume().catch(() => {});
    const buf = new Uint8Array(analyser.fftSize);
    this.timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      // sqrt again so speech (low RMS) fills a sensible part of the bar.
      this.levels.push(Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length)) * 1.4));
    }, LEVEL_INTERVAL_MS);
  }

  elapsed() {
    return Date.now() - this.startedAt;
  }

  private release() {
    window.clearInterval(this.timer);
    this.stream.getTracks().forEach((t) => t.stop());
    this.ctx.close().catch(() => {});
  }

  stop(): Promise<Recording> {
    const durationMs = this.elapsed();
    return new Promise((resolve, reject) => {
      this.recorder.onstop = async () => {
        this.release();
        const blob = new Blob(this.chunks, { type: this.recorder.mimeType || "audio/mp4" });
        if (!blob.size) return reject(new Error("Nothing was recorded."));
        resolve({
          bytes: new Uint8Array(await blob.arrayBuffer()),
          mime: blob.type,
          durationMs,
          recordedAt: this.startedAt,
          peaks: toPeaks(this.levels),
        });
      };
      this.recorder.stop();
    });
  }

  cancel() {
    this.recorder.onstop = null;
    if (this.recorder.state !== "inactive") this.recorder.stop();
    this.release();
  }
}

/** "1:05" */
export function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Decrypted audio is cached as blob: URLs for this unlocked session only.
const cache = new Map<string, Promise<string>>();

export function voiceUrl(note: VoiceNote): Promise<string> {
  let url = cache.get(note.id);
  if (!url) {
    url = api.getVoiceNote(note.id).then((buf) => URL.createObjectURL(new Blob([buf], { type: note.mime })));
    url.catch(() => cache.delete(note.id));
    cache.set(note.id, url);
  }
  return url;
}

/** Forget all decrypted audio (called when the diary locks). */
export function clearVoiceCache() {
  for (const p of cache.values()) p.then(URL.revokeObjectURL, () => {});
  cache.clear();
}
