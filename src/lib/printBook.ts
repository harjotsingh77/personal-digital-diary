import { api, emptyPayload, type Entry } from "./api";
import { formatStamp } from "../components/editor/TimeStampNode";
import { formatDuration } from "./voice";
import { photoUrl } from "./photos";
import { formatLong } from "./dates";

const escapeText = (s: string) => {
  const el = document.createElement("div");
  el.textContent = s;
  return el.innerHTML;
};

/** Swap the interactive blocks for what can exist on paper. */
function printableHTML(entry: Entry): string {
  const doc = new DOMParser().parseFromString(entry.content || "", "text/html");
  doc.querySelectorAll("[data-time-stamp]").forEach((el) => {
    const p = doc.createElement("p");
    p.className = "print-note";
    p.textContent = formatStamp(Number(el.getAttribute("data-time")));
    el.replaceWith(p);
  });
  doc.querySelectorAll("[data-voice-note]").forEach((el) => {
    const p = doc.createElement("p");
    p.className = "print-note";
    const transcript = el.getAttribute("data-transcript");
    p.textContent = `Voice note, ${formatDuration(Number(el.getAttribute("data-duration-ms")))}${transcript ? `: “${transcript}”` : ""}`;
    el.replaceWith(p);
  });
  doc.querySelectorAll("[data-video-note]").forEach((el) => {
    const wrap = doc.createElement("div");
    const poster = el.getAttribute("data-poster");
    if (poster) {
      const img = doc.createElement("img");
      img.src = poster;
      img.alt = "";
      wrap.append(img);
    }
    const p = doc.createElement("p");
    p.className = "print-note";
    p.textContent = `Video note, ${formatDuration(Number(el.getAttribute("data-duration-ms")))}`;
    wrap.append(p);
    el.replaceWith(wrap);
  });
  return doc.body.innerHTML;
}

/**
 * Lay out every page in a date range and open the system print dialog, whose
 * PDF menu saves the book as a file. Returns how many pages went in.
 */
export async function printBook(from: string, to: string): Promise<number> {
  const summaries = (await api.listEntries())
    .filter((e) => e.date >= from && e.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));

  const root = document.getElementById("print-root") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "print-root" }));
  const sections: string[] = [];
  const pendingImages: Promise<unknown>[] = [];

  for (const s of summaries) {
    const stored = await api.getEntry(s.date);
    if (!stored) continue;
    const entry = { ...emptyPayload(), ...stored };
    const photos = await Promise.all(entry.photos.map((id) => photoUrl(id).catch(() => null)));
    sections.push(
      `<section class="print-page"><div class="print-date">${escapeText(formatLong(s.date))}</div>` +
        (entry.title ? `<h2>${escapeText(entry.title)}</h2>` : "") +
        printableHTML(entry) +
        photos.filter(Boolean).map((url) => `<img src="${url}" alt="">`).join("") +
        `</section>`,
    );
  }
  root.innerHTML = sections.join("");

  // Printing before the images decode would leave blank spaces.
  root.querySelectorAll("img").forEach((img) => pendingImages.push(img.decode().catch(() => {})));
  await Promise.all(pendingImages);
  await document.fonts.ready;

  await api.printPage();
  return sections.length;
}
