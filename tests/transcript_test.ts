// The conversation log: turns, repair after a crash, secrets, search.
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import type { Message } from "../src/llm.ts";
import { lastTurns, splitTurns, Transcript, wellFormed } from "../src/transcript.ts";
import { compact, isContextError } from "../src/compact.ts";
import { LLMError } from "../src/llm.ts";
import { secrets } from "../src/secrets.ts";

const call = (id: string) => ({
  id,
  type: "function" as const,
  function: { name: "run", arguments: '{"command":"ls"}' },
});

Deno.test("turns start at user messages; unanswered tool calls are cut", () => {
  const h: Message[] = [
    { role: "assistant", content: "stray" },
    { role: "user", content: "a" },
    { role: "assistant", content: "", tool_calls: [call("1")] },
    { role: "tool", tool_call_id: "1", content: "out" },
    { role: "assistant", content: "done" },
    { role: "user", content: "b" },
    { role: "assistant", content: "", tool_calls: [call("2")] },
  ];
  assertEquals(splitTurns(h).length, 3);
  const w = wellFormed(h);
  assertEquals(w[0].content, "a");
  assertEquals(w.at(-1)!.content, "b", "the call that never got a result is dropped");
  assertEquals(lastTurns(h, 1).map((m) => m.content), ["b"]);
  assertEquals(lastTurns(h, 6).length, 5);
});

Deno.test("the log is JSONL in the chat format, with secrets scrubbed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "history", "t.jsonl");
    const t = new Transcript(path);
    await t.init();
    secrets.set(["box"], "sudo", "hunter2-pass");
    t.append({ role: "user", content: "my password is hunter2-pass" });
    t.append({ role: "assistant", content: "", tool_calls: [call("c1")] });
    secrets.clear();
    const lines = (await Deno.readTextFile(path)).trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(lines.length, 2);
    assertEquals(lines[0].role, "user");
    assertEquals(lines[0].content, "my password is [secret]");
    assert(lines[0].ts && lines[0].session === t.session);
    assertEquals(lines[1].tool_calls[0].function.name, "run");
    // A half-written last line (a crash) is skipped.
    await Deno.writeTextFile(path, '{"role":"user","con', { append: true });
    assertEquals((await t.lines()).length, 2);
    const r = await new Transcript(path).restore();
    assertEquals(
      r!.messages,
      [{ role: "user", content: "my password is [secret]" }],
      "the unanswered call is cut",
    );
    assertEquals((await t.search("run ls"))[0].includes("assistant:"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("context errors are recognised", () => {
  for (
    const m of [
      "x: HTTP 400: the request exceeds the available context size",
      "x: HTTP 400: This model's maximum context length is 32768 tokens",
      "x: HTTP 400: context_length_exceeded",
      "x: HTTP 400: prompt is too long: 210000 tokens",
    ]
  ) assert(isContextError(new LLMError(m, false)), m);
  assert(!isContextError(new LLMError("x: HTTP 401: bad key", false)));
  assert(!isContextError(new Error("the request exceeds the available context size")));
});

Deno.test("compaction keeps the last 2 turns verbatim; without a summary it drops", async () => {
  const h: Message[] = [];
  for (const n of [1, 2, 3, 4]) {
    h.push({ role: "user", content: `q${n}` }, { role: "assistant", content: `a${n}` });
  }
  const r = await compact(h, (text) => Promise.resolve(`summary of ${text.length} chars`));
  assertEquals(r!.summarized, 2);
  assertEquals(r!.history.slice(2).map((m) => m.content), ["q3", "a3", "q4", "a4"]);
  assert(r!.history[0].content.includes("summary of"));
  const failed = await compact(h, () => Promise.reject(new Error("down")));
  assert(failed!.history[0].content.includes("dropped"));
  assertEquals(await compact(h.slice(0, 4), () => Promise.resolve("x")), null, "only 2 turns");
});
