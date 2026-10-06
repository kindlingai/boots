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

export interface TraceLine extends Message {
  ts: string;
  session: string;
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
export function lastTurns(lines: Message[], n: number): Message[] {
  const msgs = lines.map(({ role, content, tool_calls, tool_call_id }) => {
    const m: Message = { role, content: content ?? "" };
    if (tool_calls?.length) m.tool_calls = tool_calls;
    if (tool_call_id) m.tool_call_id = tool_call_id;
    return m;
  }).filter((m) => m.role !== "system");
  return wellFormed(splitTurns(wellFormed(msgs)).slice(-n).flat());
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

  append(m: Message): void {
    const line: TraceLine = { ts: new Date().toISOString(), session: this.session, ...m };
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

  /** The last `turns` turns of earlier sessions, and when the last of them happened. */
  async restore(turns = 6): Promise<{ messages: Message[]; at: string } | null> {
    const earlier = (await this.lines()).filter((l) => l.session !== this.session);
    const messages = lastTurns(earlier, turns);
    if (!messages.length) return null;
    return { messages, at: earlier.at(-1)!.ts };
  }

  /**
   * Lines matching every word of the query (case-insensitive), newest first,
   * each as "time role: text" clipped around the first match.
   */
  async search(query: string, limit = 20): Promise<string[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const hits: string[] = [];
    for (const l of (await this.lines()).reverse()) {
      const calls = (l.tool_calls ?? []).map((c) => `${c.function.name}(${c.function.arguments})`)
        .join(" ");
      const text = `${l.content ?? ""} ${calls}`.replace(/\s+/g, " ").trim();
      const low = text.toLowerCase();
      if (!words.every((w) => low.includes(w))) continue;
      const at = Math.max(0, low.indexOf(words[0]) - 100);
      const clip = (at > 0 ? "…" : "") + text.slice(at, at + 300) +
        (text.length > at + 300 ? "…" : "");
      hits.push(`${l.ts.slice(0, 16).replace("T", " ")} ${l.role}: ${clip}`);
      if (hits.length >= limit) break;
    }
    return hits;
  }
}
