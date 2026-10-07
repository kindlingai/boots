// The bot and its moods, shared by the TUI and the GUI. Everything here is
// self-contained (no imports, no outside names) so the GUI can ship the very
// same functions to its page with toString(): the bot looks the same in both.
//
//    +-----+
//    | o o |
//    +-----+
//      | |
//     b   d

export type Mood = "idle" | "thinking" | "talking" | "working" | "happy" | "sad" | "asking";

/** What the mood is worked out from. */
export interface MoodInput {
  flash: { mood: Mood; until: number } | null;
  streaming: boolean;
  talkedAt: number;
  progress: boolean;
  busy: string | null;
  prompt: string | null;
}

export function moodOf(s: MoodInput, now: number = Date.now()): Mood {
  if (s.flash && now < s.flash.until) return s.flash.mood;
  if (s.streaming || now - s.talkedAt < 1200) return "talking";
  if (s.progress) return "working";
  // Running a command, connecting, compacting: hard at work.
  if (s.busy && /^(running|connecting|compacting|checking)/.test(s.busy)) return "working";
  if (s.busy) return "thinking";
  if (s.prompt && /run it\?|\[y\/n\]|\[Y\/n\]|password|choice/i.test(s.prompt)) return "asking";
  return "idle";
}

/** The bot, 6 rows by 9 columns, for a mood and an animation frame. */
export function bot(mood: Mood, frame: number, blink: boolean): string[] {
  const eyes = (() => {
    switch (mood) {
      case "thinking":
        return ["o o  ", " o o ", "  o o", " o o "][frame % 4];
      case "talking":
        return frame % 2 ? " o o " : " ^ ^ ";
      case "working":
        return frame % 2 ? " * * " : " + + ";
      case "happy":
        return " ^ ^ ";
      case "sad":
        return " x x ";
      case "asking":
        return " o O ";
      default:
        return blink ? " - - " : " o o ";
    }
  })();
  const antenna = mood === "asking"
    ? "    ?    "
    : mood === "thinking" || mood === "working"
    ? (frame % 2 ? "    *    " : "    .    ")
    : "    |    ";
  const mouth = mood === "talking" && frame % 2 ? " +--o--+ " : " +-----+ ";
  const feet = mood === "working" ? (frame % 2 ? "  b   d  " : "   b d   ") : "  b   d  ";
  const art = [antenna, " +-----+ ", ` |${eyes}| `, mouth, "   | |   ", feet];
  return mood === "working" ? sweat(art, frame) : art;
}

/**
 * Anime sweat while it works: a drop runs down each side of the head,
 * half a cycle apart, so something moves every frame or two.
 */
export const DROP: (null | [number, string])[] = [
  [1, "'"],
  [1, "'"],
  [2, "'"],
  [2, "'"],
  [3, ","],
  [3, "."],
  null,
  null,
];

export function sweat(art: string[], frame: number): string[] {
  const out = [...art];
  const put = (row: number, col: number, ch: string) => {
    out[row] = out[row].slice(0, col) + ch + out[row].slice(col + 1);
  };
  const right = DROP[frame % DROP.length];
  const left = DROP[(frame + DROP.length / 2) % DROP.length];
  if (right) put(right[0], 8, right[1]);
  if (left) put(left[0], 0, left[1]);
  return out;
}

/** Splits text into lines of at most `w` columns, at spaces where it can. */
export function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\t/g, "  ");
    if (!line) {
      out.push("");
      continue;
    }
    while ([...line].length > w) {
      const chars = [...line];
      let cut = chars.slice(0, w + 1).lastIndexOf(" ");
      if (cut <= w / 3) cut = w;
      out.push(chars.slice(0, cut).join("").trimEnd());
      line = chars.slice(cut).join("").replace(/^ /, "");
    }
    out.push(line);
  }
  return out;
}
