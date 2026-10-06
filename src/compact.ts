// Compaction: when the conversation no longer fits the model, summarise the
// older turns with the model itself and keep the last two turns verbatim.

import { LLMError, type Message } from "./llm.ts";
import { splitTurns } from "./transcript.ts";

/** The server refused the request because it is longer than the model's context. */
export function isContextError(e: unknown): boolean {
  if (!(e instanceof LLMError)) return false;
  return /context[ _-]?(length|size|window)|exceeds? (the )?(available |maximum )?context|maximum context|too many tokens|prompt is too long|input is too long|exceed_context/i
    .test(e.message);
}

export const SUMMARY_PROMPT =
  `You compact a conversation between a user and ai-bootstrap, a terminal agent that sets up AI models and infrastructure. Write a summary that lets the agent carry on without the original: the user's goals and preferences, the machines involved (hosts, OS, GPUs, users, paths, ports, URLs), what was installed or changed and how, decisions made, problems hit and their fixes, and what is still pending. Keep exact names, versions, commands and paths. Bullet points, no preamble.`;

/** The conversation as plain text for the summariser, tool output clipped. */
export function asText(msgs: Message[], perTool = 1500): string {
  return msgs.map((m) => {
    const calls = (m.tool_calls ?? []).map((c) => `${c.function.name}(${c.function.arguments})`);
    let content = m.content ?? "";
    if (m.role === "tool" && content.length > perTool) {
      content = `${content.slice(0, perTool * 0.6)}\n…\n${content.slice(-perTool * 0.3)}`;
    }
    return `[${m.role}] ${content}${calls.length ? `\n  calls: ${calls.join("; ")}` : ""}`;
  }).join("\n");
}

/** Clips long tool output, the last resort when even recent turns do not fit. */
export function clipTools(msgs: Message[], max = 3000): Message[] {
  return msgs.map((m) =>
    m.role === "tool" && m.content.length > max
      ? {
        ...m,
        content: `${m.content.slice(0, max * 0.6)}\n...[output cut to fit the context]...\n${
          m.content.slice(-max * 0.3)
        }`,
      }
      : m
  );
}

/**
 * The history with all but the last `keep` turns replaced by a summary.
 * `summarize` gets the older turns as text (at most `maxChars`, the newest
 * kept); if it fails they are dropped with a note. null: nothing to compact.
 */
export async function compact(
  history: Message[],
  summarize: (text: string) => Promise<string>,
  keep = 2,
  maxChars = 40_000,
): Promise<{ history: Message[]; summarized: number; summary: string | null } | null> {
  const turns = splitTurns(history);
  if (turns.length <= keep) return null;
  const old = turns.slice(0, -keep).flat();
  const recent = turns.slice(-keep).flat();
  let text = asText(old);
  if (text.length > maxChars) text = "…" + text.slice(-maxChars);
  let summary: string | null = null;
  try {
    summary = (await summarize(text)).trim() || null;
  } catch {
    summary = null;
  }
  const note = summary
    ? `(The earlier conversation was compacted to fit the context. Summary of it:)\n\n${summary}`
    : "(The earlier conversation was dropped to fit the context; history_search can look through it.)";
  return {
    history: [
      { role: "user", content: note },
      { role: "assistant", content: "Understood. Continuing from there." },
      ...recent,
    ],
    summarized: turns.length - keep,
    summary,
  };
}
