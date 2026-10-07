// The conversation log: every message as it happens, one JSON object per
// line (JSONL) in the OpenAI chat format, with a timestamp and a session id:
//
//   {"ts":"2026-10-06T22:31:05.120Z","session":"…","role":"user","content":"…"}
//   {"ts":…,"session":…,"role":"assistant","content":"","tool_calls":[…]}
//   {"ts":…,"session":…,"role":"tool","tool_call_id":"call_0","content":"…"}
//
// A new session restores the last few turns from it, and history_search
// looks through all of it. Remembered secrets are scrubbed before writing.

import { dirname, join } from "@std/path";
import type { Message } from "./llm.ts";
import { dataDir } from "./platform.ts";
import { secrets } from "./secrets.ts";
import { STOPWORDS } from "./memory.ts";

export interface TraceLine extends Message {
  ts: string;
  session: string;
  /** Where the agent was when this was written, e.g. "local > admin@gx10". */
  location?: string;
}

/** Past this size the oldest half is dropped at startup. */
const MAX_BYTES = 20_000_000;

export function transcriptPath(): string {
  return join(dataDir(), "history", "transcript.jsonl");
}

/** Splits a history into turns, each starting at a user message. */
export function splitTurns(history: Message[]): Message[][] {
  const turns: Message[][] = [];
  for (const m of history) {
    if (m.role === "user" || !turns.length) turns.push([m]);
    else turns.at(-1)!.push(m);
  }
  return turns;
}

/**
 * Drops what a chat API would reject: a leading non-user message, and tool
 * calls whose results never arrived (the program stopped mid-turn).
 */
export function wellFormed(history: Message[]): Message[] {
  const out = [...history];
  while (out.length && out[0].role !== "user") out.shift();
  const answered = new Set(out.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (let i = out.length - 1; i >= 0; i--) {
    const calls = out[i].tool_calls ?? [];
    if (out[i].role === "assistant" && calls.some((c) => !answered.has(c.id))) {
      // Cut from this unanswered call on.
      return wellFormed(out.slice(0, i));
    }
  }
  return out;
}

/** The last `n` turns, as plain chat messages. */
/**
 * The last `n` turns, or more while they fit in `maxChars` (whichever gives
 * more): a restart picks up enough of the conversation to carry on.
 */
export function lastTurns(lines: Message[], n: number, maxChars = 0): Message[] {
  const msgs = lines.map(({ role, content, tool_calls, tool_call_id }) => {
    const m: Message = { role, content: content ?? "" };
    if (tool_calls?.length) m.tool_calls = tool_calls;
    if (tool_call_id) m.tool_call_id = tool_call_id;
    return m;
  }).filter((m) => m.role !== "system");
  const turns = splitTurns(wellFormed(msgs));
  const size = (t: Message[]) =>
    t.reduce((a, m) => a + m.content.length + JSON.stringify(m.tool_calls ?? "").length, 0);
  let take = Math.min(n, turns.length);
  let used = turns.slice(turns.length - take).reduce((a, t) => a + size(t), 0);
  while (take < turns.length) {
    const next = size(turns[turns.length - take - 1]);
    if (used + next > maxChars) break;
    used += next;
    take++;
  }
  return wellFormed(turns.slice(turns.length - take).flat());
}

function scrub(text: string): string {
  for (const v of secrets.values()) {
    if (v.length >= 4) text = text.split(v).join("[secret]");
  }
  return text;
}

export class Transcript {
  readonly session = crypto.randomUUID();

  constructor(readonly path = transcriptPath()) {}

  /** Creates the folder and keeps the file to a reasonable size. */
  async init(): Promise<void> {
    try {
      await Deno.mkdir(dirname(this.path), { recursive: true });
      const st = await Deno.stat(this.path).catch(() => null);
      if (st && st.size > MAX_BYTES) {
        const text = await Deno.readTextFile(this.path);
        const cut = text.indexOf("\n", text.length / 2);
        await Deno.writeTextFile(this.path, text.slice(cut + 1));
      }
    } catch {
      // The log is a convenience: never stop the program over it.
    }
  }

  append(m: Message, location?: string): void {
    const line: TraceLine = { ts: new Date().toISOString(), session: this.session, location, ...m };
    try {
      Deno.writeTextFileSync(this.path, scrub(JSON.stringify(line)) + "\n", { append: true });
    } catch {
      // as above
    }
  }

  /** Every line written so far, oldest first; unreadable lines are skipped. */
  async lines(): Promise<TraceLine[]> {
    let text = "";
    try {
      text = await Deno.readTextFile(this.path);
    } catch {
      return [];
    }
    const out: TraceLine[] = [];
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      try {
        const j = JSON.parse(l);
        if (j && typeof j.role === "string") out.push(j);
      } catch {
        // a line cut short by a crash
      }
    }
    return out;
  }

  /**
   * The last `turns` turns of earlier sessions (more while they fit in
   * `maxChars`), when the last of them
   * happened, and where the agent was then (a hop that is gone now).
   */
  async restore(
    turns = 6,
    maxChars = 0,
  ): Promise<{ messages: Message[]; at: string; location?: string } | null> {
    const earlier = (await this.lines()).filter((l) => l.session !== this.session);
    const messages = lastTurns(earlier, turns, maxChars);
    if (!messages.length) return null;
    const last = earlier.at(-1)!;
    return { messages, at: last.ts, location: last.location };
  }

  /**
   * Lines matching any of the query's terms, best first. A term also matches
   * its parts and its stem ("workers" finds "worker", "exl3up-run.sh" finds
   * "exl3up"). Rare terms weigh more than common ones, so a line with the
   * one distinctive name beats one with two everyday words; ties go to the
   * newest. Each is "time role: text" clipped around the first match, marked
   * with how many terms it matched when not all.
   */
  async search(query: string, limit = 20): Promise<string[]> {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const matched: { hit: boolean[]; first: number; text: string; l: TraceLine; n: number }[] = [];
    const df = terms.map(() => 0);
    const lines = (await this.lines()).reverse();
    lines.forEach((l, n) => {
      const calls = (l.tool_calls ?? []).map((c) => `${c.function.name}(${c.function.arguments})`)
        .join(" ");
      const text = `${l.content ?? ""} ${calls}`.replace(/\s+/g, " ").trim();
      const low = text.toLowerCase();
      let first = -1;
      const hit = terms.map((forms, k) => {
        const at = forms.map((f) => low.indexOf(f)).filter((i) => i >= 0);
        if (!at.length) return false;
        df[k]++;
        const i = Math.min(...at);
        if (first < 0 || i < first) first = i;
        return true;
      });
      if (first >= 0) matched.push({ hit, first, text, l, n });
    });
    const weight = df.map((d) => Math.log(1 + lines.length / Math.max(1, d)));
    const scored = matched.map((m) => ({
      ...m,
      count: m.hit.filter(Boolean).length,
      score: m.hit.reduce((s, h, k) => s + (h ? weight[k] : 0), 0),
    }));
    scored.sort((a, b) => b.score - a.score || a.n - b.n);
    return scored.slice(0, limit).map(({ first, text, l, count }) => {
      const at = Math.max(0, first - 100);
      const clip = (at > 0 ? "…" : "") + text.slice(at, at + 300) +
        (text.length > at + 300 ? "…" : "");
      const partial = count < terms.length ? ` (${count}/${terms.length} words)` : "";
      return `${l.ts.slice(0, 16).replace("T", " ")} ${l.role}${partial}: ${clip}`;
    });
  }
}

/**
 * The query's terms, each with the forms that count as a match: the word,
 * the parts of a compound (exl3up-run.sh: exl3up, run), and a plain stem
 * (workers: worker, stopping: stopp/stop).
 */
export function searchTerms(query: string): string[][] {
  const words = [...new Set(query.toLowerCase().split(/\s+/))]
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return words.map((w) => {
    const forms = new Set([w]);
    for (const p of w.split(/[^a-z0-9]+/)) if (p.length > 2 && !STOPWORDS.has(p)) forms.add(p);
    const stem = w.replace(/(ing|ed|es|s)$/, "");
    if (stem.length > 2 && stem !== w) forms.add(stem);
    if (/(.)\1$/.test(stem) && stem.length > 3) forms.add(stem.slice(0, -1));
    return [...forms];
  });
}
