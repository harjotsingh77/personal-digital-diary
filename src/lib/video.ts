import { api, type VideoNote } from "./api";
import { device, privacySettings } from "./platform";

/** WKWebView (the real app) records H.264 in mp4; Chromium prefers WebM. */
const MIME_CANDIDATES = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"];
/** The recorder hands over a chunk this often, and each goes straight to disk. */
const CHUNK_MS = 1000;
const POSTER_WIDTH = 480;

function cameraError(e: unknown): Error {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error(`Camera access is off. ${privacySettings("Camera")}`);
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return new Error("No camera found.");
  if (typeof MediaRecorder === "undefined") return new Error(`Video recording isn't supported on this ${device}.`);
  return new Error("Couldn't start the camera.");
}

/** The camera and mic, open for a preview before any recording starts. */
export async function openCamera(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    throw cameraError(e);
  }
}

/**
 * One recording. There's no length limit, so nothing is kept in memory: every
 * chunk goes to the backend as it arrives, strictly in order, and is encrypted
 * onto disk there.
 */
export class VideoRecording {
  readonly startedAt = Date.now();
  private writes: Promise<void>;
  private failure: unknown = null;
  private poster = "";

  private constructor(
    private recorder: MediaRecorder,
    private preview: HTMLVideoElement,
  ) {
    this.writes = api.videoBegin();
  }

  static start(stream: MediaStream, preview: HTMLVideoElement): VideoRecording {
    let recorder: MediaRecorder;
    try {
      const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (e) {
      throw cameraError(e);
    }
    const rec = new VideoRecording(recorder, preview);
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      const blob = e.data;
      rec.writes = rec.writes.then(async () => {
        if (rec.failure) return;
        try {
          await api.videoAppend(new Uint8Array(await blob.arrayBuffer()));
        } catch (err) {
          rec.failure = err;
        }
      });
    };
    recorder.start(CHUNK_MS);
    return rec;
  }

  elapsed() {
    return Date.now() - this.startedAt;
  }

  /** Set when writing to disk failed (a full disk, say) and recording should stop. */
  get error() {
    return this.failure;
  }

  private capturePoster() {
    const v = this.preview;
    if (!v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = POSTER_WIDTH;
    canvas.height = Math.round((POSTER_WIDTH * v.videoHeight) / v.videoWidth);
    canvas.getContext("2d")?.drawImage(v, 0, 0, canvas.width, canvas.height);
    this.poster = canvas.toDataURL("image/jpeg", 0.7);
  }

  stop(): Promise<VideoNote> {
    const durationMs = this.elapsed();
    this.capturePoster();
    const mime = (this.recorder.mimeType || "video/mp4").split(";")[0];
    return new Promise((resolve, reject) => {
      this.recorder.onstop = async () => {
        await this.writes;
        if (this.failure) {
          await api.videoCancel().catch(() => {});
          return reject(this.failure);
        }
        try {
          const id = await api.videoFinish();
          resolve({ id, mime, durationMs, recordedAt: this.startedAt, poster: this.poster });
        } catch (e) {
          reject(e);
        }
      };
      this.recorder.stop();
    });
  }

  async cancel() {
    this.recorder.ondataavailable = null;
    this.recorder.onstop = null;
    if (this.recorder.state !== "inactive") this.recorder.stop();
    await this.writes;
    await api.videoCancel().catch(() => {});
  }
}

declare global {
  interface Window {
    /** Set by the dev-only mock backend, which has no custom protocol. */
    __diaryMockVideoUrl?: (id: string) => string | undefined;
  }
}

/** Where the player streams from; the backend decrypts ranges on request. */
export function videoUrl(note: Pick<VideoNote, "id" | "mime">): string {
  const mock = window.__diaryMockVideoUrl?.(note.id);
  if (mock) return mock;
  return `diaryvideo://localhost/${note.id}?t=${note.mime.includes("webm") ? "webm" : "mp4"}`;
}
