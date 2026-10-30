import { useEditorState, type Editor } from "@tiptap/react";
import {
  Bold, Heading1, Heading2, Italic, List, ListChecks, ListOrdered, Quote, Strikethrough,
  type LucideIcon,
} from "lucide-react";

interface Tool {
  icon: LucideIcon;
  label: string;
  shortcut: string;
  isActive: (e: Editor) => boolean;
  run: (e: Editor) => void;
}

const TOOLS: (Tool | "sep")[] = [
  { icon: Bold, label: "Bold", shortcut: "⌘B", isActive: (e) => e.isActive("bold"), run: (e) => e.chain().focus().toggleBold().run() },
  { icon: Italic, label: "Italic", shortcut: "⌘I", isActive: (e) => e.isActive("italic"), run: (e) => e.chain().focus().toggleItalic().run() },
  { icon: Strikethrough, label: "Strikethrough", shortcut: "⌘⇧S", isActive: (e) => e.isActive("strike"), run: (e) => e.chain().focus().toggleStrike().run() },
  "sep",
  { icon: Heading1, label: "Heading", shortcut: "⌘⌥1", isActive: (e) => e.isActive("heading", { level: 1 }), run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { icon: Heading2, label: "Subheading", shortcut: "⌘⌥2", isActive: (e) => e.isActive("heading", { level: 2 }), run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  "sep",
  { icon: List, label: "Bullet list", shortcut: "⌘⇧8", isActive: (e) => e.isActive("bulletList"), run: (e) => e.chain().focus().toggleBulletList().run() },
  { icon: ListOrdered, label: "Numbered list", shortcut: "⌘⇧7", isActive: (e) => e.isActive("orderedList"), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { icon: ListChecks, label: "Checklist", shortcut: "⌘⇧9", isActive: (e) => e.isActive("taskList"), run: (e) => e.chain().focus().toggleTaskList().run() },
  { icon: Quote, label: "Quote", shortcut: "⌘⇧B", isActive: (e) => e.isActive("blockquote"), run: (e) => e.chain().focus().toggleBlockquote().run() },
];

export function Toolbar({ editor }: { editor: Editor }) {
  // TipTap v3 doesn't re-render on every keystroke; subscribe to just the
  // active-state flags we need.
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => TOOLS.map((t) => (t === "sep" ? false : t.isActive(e))),
  });

  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-label="Formatting">
      {TOOLS.map((t, i) =>
        t === "sep" ? (
          <span key={i} className="mx-1.5 h-4 w-px bg-line" />
        ) : (
          <button
            key={t.label}
            type="button"
            title={`${t.label} (${t.shortcut})`}
            aria-label={t.label}
            aria-pressed={active[i]}
            onMouseDown={(e) => e.preventDefault()} // keep editor selection
            onClick={() => t.run(editor)}
            className={`flex size-8 items-center justify-center rounded-md transition-colors ${
              active[i] ? "bg-accent-soft text-accent" : "text-muted hover:bg-ink/5 hover:text-ink"
            }`}
          >
            <t.icon size={16} strokeWidth={2} />
          </button>
        ),
      )}
    </div>
  );
}
