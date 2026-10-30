// Per-Mac conveniences kept in localStorage. Nothing here comes from the diary.

const get = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const set = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* it just won't be remembered */ }
};

export type PageFont = "hand" | "serif";

export const pageFont = (): PageFont => (get("page-font") === "serif" ? "serif" : "hand");

export function applyPageFont(font: PageFont = pageFont()) {
  document.documentElement.dataset.pageFont = font;
  set("page-font", font);
}

export const TRANSCRIPTION_LANGUAGES = [
  { id: "en-IN", label: "English (India)" },
  { id: "en-US", label: "English (US)" },
  { id: "hi-IN", label: "Hindi" },
];

export const transcriptionLanguage = () => get("transcription-language") ?? "en-IN";
export const setTranscriptionLanguage = (id: string) => set("transcription-language", id);

// ── Colours ──────────────────────────────────────────────────────────
// Everything derives from one page colour and one accent, so any colour
// someone picks gives a complete theme with readable text.

export type ThemeMode = "system" | "light" | "dark";

/** Each swatch has a shade for light mode and one for dark mode. */
export interface Swatch {
  id: string;
  label: string;
  light: string;
  dark: string;
}

export const PAGE_COLOURS: Swatch[] = [
  { id: "cream", label: "Cream", light: "#fdf9f1", dark: "#25211c" },
  { id: "white", label: "White and charcoal", light: "#ffffff", dark: "#232323" },
  { id: "sepia", label: "Sepia", light: "#f3e6cf", dark: "#2c2419" },
  { id: "rose", label: "Rose", light: "#fbeeea", dark: "#2a2024" },
  { id: "sage", label: "Sage", light: "#eef2e6", dark: "#1f2620" },
  { id: "sky", label: "Sky", light: "#eaf1f6", dark: "#1c2330" },
];

export const ACCENT_COLOURS: Swatch[] = [
  { id: "terracotta", label: "Terracotta", light: "#b8734a", dark: "#d9925f" },
  { id: "rose", label: "Rose", light: "#b4506a", dark: "#e08aa0" },
  { id: "forest", label: "Forest", light: "#4f7f5a", dark: "#7fb88c" },
  { id: "ocean", label: "Ocean", light: "#3a7396", dark: "#6fb0d6" },
  { id: "plum", label: "Plum", light: "#7b5a9e", dark: "#b195d6" },
  { id: "ink", label: "Ink", light: "#4a4a4a", dark: "#c9c9c9" },
];

export interface Colours {
  mode: ThemeMode;
  /** A swatch id, or a "#rrggbb" colour someone picked. */
  page: string;
  accent: string;
}

export const DEFAULT_COLOURS: Colours = { mode: "system", page: "cream", accent: "terracotta" };

const HEX = /^#[0-9a-f]{6}$/i;

export function loadColours(): Colours {
  try {
    const saved = JSON.parse(get("colours") ?? "{}") as Partial<Colours>;
    const known = (v: unknown, swatches: Swatch[], fallback: string) =>
      typeof v === "string" && (HEX.test(v) || swatches.some((s) => s.id === v)) ? v : fallback;
    return {
      mode: saved.mode === "light" || saved.mode === "dark" ? saved.mode : "system",
      page: known(saved.page, PAGE_COLOURS, DEFAULT_COLOURS.page),
      accent: known(saved.accent, ACCENT_COLOURS, DEFAULT_COLOURS.accent),
    };
  } catch {
    return DEFAULT_COLOURS;
  }
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
export const isDark = (mode: ThemeMode) => mode === "dark" || (mode === "system" && systemDark());

function resolve(value: string, swatches: Swatch[], dark: boolean): string {
  if (HEX.test(value)) return value;
  const swatch = swatches.find((s) => s.id === value) ?? swatches[0];
  return dark ? swatch.dark : swatch.light;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const OVERRIDDEN = [
  "--page", "--paper", "--desk", "--sidebar", "--surface", "--page-edge", "--ink", "--muted", "--line", "--rule", "--shadow",
  "--accent", "--accent-soft", "--chart",
];

const mix = (a: string, percent: number, b: string) => `color-mix(in srgb, ${a} ${percent}%, ${b})`;

export function applyColours(colours: Colours = loadColours()) {
  const root = document.documentElement;
  const dark = isDark(colours.mode);
  if (colours.mode === "system") delete root.dataset.theme;
  else root.dataset.theme = colours.mode;

  const style = root.style;
  OVERRIDDEN.forEach((name) => style.removeProperty(name));
  style.removeProperty("color-scheme");

  // The defaults live in styles.css; only other choices need working out.
  if (colours.page !== DEFAULT_COLOURS.page) {
    const page = resolve(colours.page, PAGE_COLOURS, dark);
    // Follows the page, not the mode: a custom pale page still needs dark ink.
    const darkPage = luminance(page) < 0.18;
    const ink = darkPage ? "#ece4d9" : "#2e2924";
    style.setProperty("color-scheme", darkPage ? "dark" : "light");
    style.setProperty("--page", page);
    style.setProperty("--paper", mix(page, darkPage ? 80 : 94, darkPage ? "black" : "#8a7f73"));
    style.setProperty("--desk", mix(page, darkPage ? 55 : 87, darkPage ? "black" : "#6b5a48"));
    style.setProperty("--sidebar", mix(page, darkPage ? 70 : 90, darkPage ? "black" : "#6b5a48"));
    style.setProperty("--surface", mix(page, darkPage ? 92 : 60, "white"));
    style.setProperty("--page-edge", mix(page, 90, ink));
    style.setProperty("--ink", ink);
    style.setProperty("--muted", mix(ink, 62, page));
    style.setProperty("--line", mix(ink, 14, page));
    style.setProperty("--rule", mix(ink, darkPage ? 8 : 12, "transparent"));
    style.setProperty("--shadow", darkPage ? "rgba(0, 0, 0, 0.5)" : "rgba(84, 60, 36, 0.22)");
  }
  if (colours.accent !== DEFAULT_COLOURS.accent || colours.page !== DEFAULT_COLOURS.page) {
    const accent = resolve(colours.accent, ACCENT_COLOURS, dark);
    style.setProperty("--accent", accent);
    style.setProperty("--chart", accent);
    style.setProperty("--accent-soft", mix(accent, 16, "var(--page)"));
  }
}

export function saveColours(colours: Colours) {
  set("colours", JSON.stringify(colours));
  applyColours(colours);
}

/** Follow macOS switching between light and dark while the app is open. */
export function watchSystemTheme() {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyColours());
}
