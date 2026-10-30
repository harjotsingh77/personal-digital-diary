import { mergeAttributes, Node } from "@tiptap/react";

/**
 * The time written at the top of each sitting, the way you would in a paper
 * diary. It adds no text to the entry, so a page holding only a stamp still
 * counts as empty and doesn't get saved.
 */
export const TimeStampNode = Node.create({
  name: "timeStamp",
  group: "block",
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      time: { default: 0, parseHTML: (el) => Number(el.getAttribute("data-time")) || 0, renderHTML: (a) => ({ "data-time": String(a.time) }) },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-time-stamp]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-time-stamp": "", class: "time-stamp", contenteditable: "false" }, HTMLAttributes), formatStamp(node.attrs.time)];
  },
});

export const formatStamp = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export const timeStampHTML = (ms: number) => `<div data-time-stamp="" data-time="${ms}"></div>`;
