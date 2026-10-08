// read_file's narrower reads: a range of lines, the lines matching a pattern
// (with some around them), and `ask`: a question put to a separate reading
// of the file. The file goes to the model in a fresh request with no tools,
// in windows that overlap a little and each fill at most 75% of its context;
// the answers come back together, each with the lines it read. Big logs and
// configs are then read for what was asked, without filling the agent's
// own context.

/** A line of the file and its number (1-based). */
export interface Line {
  n: number;
  text: string;
}

export interface Selection {
  lines: Line[];
  /** How many lines the file has. */
  total: number;
  /** What was picked, in words ("lines 10-200, matching /error/i (14 matches)"). */
  what: string;
}

export interface Pick {
  start_line?: number;
  end_line?: number;
  pattern?: string;
  /** Lines kept before and after each match. */
  context?: number;
}

/** `(?i)error` and `/error/i` as well as a plain `error`. */
export function toRegex(pattern: string): RegExp {
  const slashed = pattern.match(/^\/(.*)\/([a-z]*)$/s);
  if (slashed) return new RegExp(slashed[1], slashed[2].replace(/[gy]/g, ""));
  const i = pattern.startsWith("(?i)");
  return new RegExp(i ? pattern.slice(4) : pattern, i ? "i" : "");
}

/** The lines a pick asks for. Throws on a pattern that is not a regex. */
export function selectLines(text: string, pick: Pick = {}): Selection {
  const all = text.split("\n");
  if (all.length > 1 && all.at(-1) === "") all.pop();
  const total = all.length;
  const from = Math.max(1, Math.floor(pick.start_line ?? 1));
  const to = Math.min(total, Math.floor(pick.end_line ?? total));
  let lines: Line[] = [];
  for (let n = from; n <= to; n++) lines.push({ n, text: all[n - 1] });
  const parts: string[] = [];
  if (pick.start_line || pick.end_line) parts.push(`lines ${from}-${to} of ${total}`);
  if (pick.pattern) {
    const re = toRegex(pick.pattern);
    const around = Math.max(0, Math.min(50, Math.floor(pick.context ?? 0)));
    const keep = new Set<number>();
    let matches = 0;
    lines.forEach((l, i) => {
      if (!re.test(l.text)) return;
      matches++;
      for (let k = Math.max(0, i - around); k <= Math.min(lines.length - 1, i + around); k++) {
        keep.add(k);
      }
    });
    lines = lines.filter((_, i) => keep.has(i));
    parts.push(
      `matching ${re}${
        around ? ` with ${around} line${around > 1 ? "s" : ""} around` : ""
      } (${matches} match${matches === 1 ? "" : "es"})`,
    );
  }
  return { lines, total, what: parts.join(", ") || `all ${total} lines` };
}

/** Lines as the model sees them: numbered, with a gap shown where lines were left out. */
export function numbered(lines: Line[]): string {
  const width = String(lines.at(-1)?.n ?? 1).length;
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i > 0 && l.n !== lines[i - 1].n + 1) out.push(`${" ".repeat(width)}  ...`);
    out.push(`${String(l.n).padStart(width)}| ${l.text}`);
  });
  return out.join("\n");
}

export interface Chunk {
  /** First and last line numbers it holds. */
  from: number;
  to: number;
  text: string;
}

/**
 * Windows of at most `budget` characters (numbered), each starting a little
 * before the previous one ended (`overlap` of its size, in whole lines), so
 * nothing that spans a boundary is read only in halves. A line longer than
 * a window is cut into pieces.
 */
export function windows(lines: Line[], budget: number, overlap = 0.1): Chunk[] {
  budget = Math.max(200, Math.floor(budget));
  // Long lines in pieces, each with its line's number.
  const width = String(lines.at(-1)?.n ?? 1).length + 2;
  const room = budget - width - 8;
  const pieces: Line[] = lines.flatMap((l) => {
    if (l.text.length <= room) return [l];
    const out: Line[] = [];
    for (let i = 0; i < l.text.length; i += room) {
      out.push({ n: l.n, text: l.text.slice(i, i + room) });
    }
    return out;
  });
  const size = (l: Line) => l.text.length + width + 1;
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < pieces.length) {
    let end = start, used = 0;
    while (end < pieces.length && (end === start || used + size(pieces[end]) <= budget)) {
      used += size(pieces[end]);
      end++;
    }
    const part = pieces.slice(start, end);
    chunks.push({ from: part[0].n, to: part.at(-1)!.n, text: numbered(part) });
    if (end >= pieces.length) break;
    // Back up by about `overlap` of the window, but always move forward.
    let back = 0, k = end;
    while (k - 1 > start + 1 && back + size(pieces[k - 1]) <= used * overlap) {
      k--;
      back += size(pieces[k]);
    }
    start = k;
  }
  return chunks;
}

export const ASK_PROMPT =
  `You read part of a file for another assistant, which cannot see it. It asked a question about the file; answer it from the part you are given only. Be specific and brief: quote the exact values, messages and names that matter, and give the line numbers (they are at the start of each line, before the |). If this part has nothing that answers the question, say only: nothing relevant in this part. Do not guess about the parts you cannot see, and do not add advice the question did not ask for.`;

/** Sends one window and returns the answer (the tests stand in for the model). */
export type Answerer = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

export interface AskOptions {
  path: string;
  question: string;
  sel: Selection;
  /** The answering model's context, in characters. */
  contextChars: number;
  answer: Answerer;
  /** At most this many windows; beyond it, the reply says to narrow the read. */
  maxWindows?: number;
  onProgress?: (done: number, of: number) => void;
  /** True when the error means the request was too long for the model. */
  tooLong?: (e: unknown) => boolean;
  signal?: AbortSignal;
}

/** The selection, read for the question, window by window; the answers joined. */
export async function askFile(o: AskOptions): Promise<string> {
  if (!o.sel.lines.length) return `nothing to read in ${o.path}: no lines (${o.sel.what})`;
  const head = (from: number, to: number, i: number, of: number) =>
    `File: ${o.path} (${o.sel.total} lines; given here: ${o.sel.what})\nThis part: lines ${from}-${to}${
      of > 1 ? ` (part ${i} of ${of}; parts overlap a little)` : ""
    }\n\nQuestion: ${o.question}\n\n`;
  const overhead = ASK_PROMPT.length + head(1, 1, 1, 1).length + 200;
  // 75% of the context for the request, leaving the rest for the answer.
  let budget = Math.floor(o.contextChars * 0.75) - overhead;
  if (budget < 1000) budget = 1000;
  let chunks = windows(o.sel.lines, budget);
  const max = o.maxWindows ?? 24;
  const skipped = chunks.length > max ? chunks.slice(max) : [];
  chunks = chunks.slice(0, max);
  const out: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    o.onProgress?.(i, chunks.length);
    const c = chunks[i];
    let answer: string;
    try {
      answer = await o.answer(
        ASK_PROMPT,
        head(c.from, c.to, i + 1, chunks.length) + c.text,
        o.signal,
      );
    } catch (e) {
      if (o.signal?.aborted) throw e;
      if (!o.tooLong?.(e)) {
        answer = `(not read: ${(e as Error).message})`;
      } else {
        // Smaller windows for this part, then on.
        const halves = windows(
          o.sel.lines.filter((l) => l.n >= c.from && l.n <= c.to),
          c.text.length / 2 + 100,
        );
        const parts: string[] = [];
        for (const h of halves) {
          try {
            parts.push(
              `lines ${h.from}-${h.to}: ${
                clean(
                  await o.answer(
                    ASK_PROMPT,
                    head(h.from, h.to, i + 1, chunks.length) + h.text,
                    o.signal,
                  ),
                )
              }`,
            );
          } catch (e2) {
            if (o.signal?.aborted) throw e2;
            parts.push(`lines ${h.from}-${h.to}: (not read: ${(e2 as Error).message})`);
          }
        }
        answer = parts.join("\n");
      }
    }
    out.push(`[lines ${c.from}-${c.to}]\n${clean(answer)}`);
  }
  o.onProgress?.(chunks.length, chunks.length);
  const intro =
    `Answers from a separate reading of ${o.path} (${o.sel.total} lines; read: ${o.sel.what}${
      chunks.length > 1 ? `; in ${chunks.length} overlapping parts` : ""
    }) for: ${o.question}`;
  const rest = skipped.length
    ? `\n\n[lines ${skipped[0].from}-${
      skipped.at(-1)!.to
    } not read: more than ${max} parts. Narrow it with start_line/end_line or pattern, then ask again.]`
    : "";
  return `${intro}\n\n${out.join("\n\n")}${rest}`;
}

const clean = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "(no answer)";
