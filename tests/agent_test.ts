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
    assertEquals(toolNames(asks[0]), ["reply", "list_models", "set_up_model", "start_full_model"]);
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
