/** Offered only on an empty page, and only if wanted: a diary shouldn't assign homework. */
export const PROMPTS = [
  "What did you want to say today, but didn't?",
  "What's been sitting on your mind?",
  "Who drained you today? Who gave you energy back?",
  "What felt quietly good today?",
  "What would you tell someone you trust right now?",
  "What are you pretending not to care about?",
  "Where did you feel most like yourself today?",
  "What do you need more of this week? Less of?",
  "What happened today that nobody else noticed?",
  "If today had a title, what would it be?",
  "What are you looking forward to, even a little?",
  "What would you like to let go of tonight?",
];

/** A prompt for the day, so the page doesn't change every time it's opened. */
export function promptFor(date: string, shift = 0): string {
  const n = [...date].reduce((sum, c) => sum + c.charCodeAt(0) * 7, 0) + shift;
  return PROMPTS[n % PROMPTS.length];
}

export interface Template {
  name: string;
  html: string;
}

export const TEMPLATES: Template[] = [
  { name: "Gratitude", html: "<h3>Three small good things</h3><ol><li><p></p></li><li><p></p></li><li><p></p></li></ol>" },
  { name: "Day review", html: "<h3>What happened</h3><p></p><h3>How it felt</h3><p></p><h3>What I'd do again</h3><p></p>" },
  { name: "Unsent letter", html: "<p>Dear ,</p><p></p><p></p><p><em>Not sending this.</em></p>" },
  { name: "Brain dump", html: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p></p></div></li></ul>' },
];
