import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { VoiceNoteNode } from "./VoiceNoteNode";
import { VideoNoteNode } from "./VideoNoteNode";
import { TimeStampNode } from "./TimeStampNode";

/** Editor features: bold, italic, headings, lists, checklists, quotes, voice and video notes, time stamps. */
export const readOnlyExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    // An offline diary has no use for clickable links or code blocks.
    link: false,
    codeBlock: false,
    // Shows where a dragged voice note will land.
    dropcursor: { color: "var(--accent)", width: 2 },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  VoiceNoteNode,
  VideoNoteNode,
  TimeStampNode,
];

export const editorExtensions = [
  ...readOnlyExtensions,
  Placeholder.configure({ placeholder: "Write anything…" }),
];
