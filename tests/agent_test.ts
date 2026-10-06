// The base model must answer with tool calls, and talks through reply.
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Agent } from "../src/agent.ts";
import { Router } from "../src/llm.ts";
import { Memory } from "../src/memory.ts";
import { McpManager } from "../src/mcp.ts";
import { Session } from "../src/tools.ts";
import { type Scripted, serveMock } from "./fixtures/mock_llm.ts";

async function session(model: string, script: Scripted[]) {
  const m = serveMock(script);
  const dir = await Deno.makeTempDir();
  const s = new Session(
    new Router({ label: model, baseUrl: m.url, model, contextChars: 40_000 }),
    new Memory(join(dir, "mem")),
    new McpManager(join(dir, "mcp.json")),
    () => Promise.resolve(null),
  );
  await s.init();
  s.allowReadonly = true;
  const done = async () => {
    await m.close();
    await Deno.remove(dir, { recursive: true });
  };
  return { m, s, agent: new Agent(s, () => ""), done };
}

const toolNames = (req: any) => req.tools.map((t: any) => t.function.name);

Deno.test("base model: on rails, tool calls required, reply ends the turn", async () => {
  const marker = await Deno.makeTempFile();
  await Deno.remove(marker);
  const { m, agent, done } = await session("qwen3-4b", [
    { calls: [{ name: "run", args: { command: `touch ${marker}` } }] },
    { calls: [{ name: "reply", args: { message: "All checked." } }] },
    { content: "never reached" },
  ]);
  try {
    await agent.turn("go");
    const asks = m.seen.filter((b) => b.tools);
    assertEquals(asks.length, 2, "the turn ends at reply");
    assertEquals(asks[0].tool_choice, "required");
    assertEquals(toolNames(asks[0]), [
      "reply",
      "list_models",
      "set_up_model",
      "start_full_model",
      "read_log",
      "remove_downloads",
    ]);
    // A tool it was not offered is refused, not run.
    const last = asks[1].messages.at(-1);
    assertEquals(last.role, "tool");
    assert(last.content.includes("run is not available to you"));
    assertEquals(await Deno.stat(marker).then(() => true, () => false), false);
  } finally {
    await done();
  }
});

Deno.test("a capable model chooses freely and has no reply tool", async () => {
  const { m, agent, done } = await session("gpt-oss-120b", [{ content: "Hello." }]);
  try {
    await agent.turn("hi");
    const ask = m.seen.find((b) => b.tools);
    assertEquals(ask.tool_choice, undefined);
    assert(!toolNames(ask).includes("reply"));
  } finally {
    await done();
  }
});

Deno.test("too long for the model: older turns are summarised, the last 2 kept, and it retries", async () => {
  const { m, agent, done } = await session("gpt-oss-120b", ["too-long", { content: "Done." }]);
  try {
    for (const n of [1, 2, 3]) {
      agent.history.push({ role: "user", content: `old question ${n}` });
      agent.history.push({ role: "assistant", content: `old answer ${n}` });
    }
    await agent.turn("new question");
    const h = agent.history;
    assert(h[0].content.startsWith("(The earlier conversation was compacted"), h[0].content);
    assertEquals(h.slice(2).map((x) => x.content), [
      "old question 3",
      "old answer 3",
      "new question",
      "Done.",
    ]);
    // The summariser saw the old turns; the retry carried the summary.
    const summary = m.seen.find((b) => !b.tools && b.messages[0].content.startsWith("You compact"));
    assert(summary.messages[1].content.includes("old question 1"));
    const retry = m.seen.filter((b) => b.tools).at(-1);
    assert(retry.messages[1].content.startsWith("(The earlier conversation was compacted"));
  } finally {
    await done();
  }
});

Deno.test("a restored session and its log", async () => {
  const { Transcript } = await import("../src/transcript.ts");
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "t.jsonl");
    const before = new Transcript(path);
    await before.init();
    for (let n = 1; n <= 8; n++) {
      before.append({ role: "user", content: `question ${n}` });
      before.append({ role: "assistant", content: `answer ${n}` });
    }
    const { s, agent, done } = await session("gpt-oss-120b", [{ content: "Hi again." }]);
    try {
      s.transcript = new Transcript(path);
      assertEquals(await agent.restore(6), 6);
      assertEquals(agent.history[0].content, "question 3");
      assertEquals(agent.history.length, 12);
      assert(agent.restoredAt);
      const sys = (await agent.system())();
      assert(sys.includes("## Restored conversation"));
      await agent.turn("hello");
      // This session is logged too, and history_search finds both.
      const hits = await s.exec("history_search", { query: "question" });
      assert(hits.split("\n")[0].includes("user: hello") === false);
      assert(hits.includes("question 8") && hits.includes("question 1"), hits);
      assert((await s.exec("history_search", { query: "again" })).includes("assistant: Hi again."));
    } finally {
      await done();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fit keeps the latest user message, shortening tool output instead", async () => {
  const { fit } = await import("../src/agent.ts");
  const call = { id: "c1", type: "function" as const, function: { name: "run", arguments: "{}" } };
  const history = [
    { role: "user" as const, content: "earlier question" },
    { role: "assistant" as const, content: "earlier answer" },
    { role: "user" as const, content: "read the config on the spark" },
    { role: "assistant" as const, content: "", tool_calls: [call] },
    { role: "tool" as const, tool_call_id: "c1", content: "x".repeat(16_000) },
  ];
  const out = fit(history, 6000);
  assertEquals(out[0].content, "read the config on the spark", "the last turn stays");
  const size = out.reduce(
    (n, m) => n + m.content.length + JSON.stringify(m.tool_calls ?? "").length,
    0,
  );
  assert(size <= 6000, `fits: ${size}`);
  assert(out.at(-1)!.content.includes("cut to fit the context"));
  assertEquals(fit(history, 1e6).length, 5, "nothing changes when it fits");
});
