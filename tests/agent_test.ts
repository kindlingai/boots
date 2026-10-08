// The base model must answer with tool calls, and talks through reply.
import { join } from "@std/path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
      "models_at",
      "use_model",
      "environment",
      "saved_models",
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
  // Too long twice: as asked, then again without max_tokens (a real overflow).
  const { m, agent, done } = await session("gpt-oss-120b", ["too-long", "too-long", {
    content: "Done.",
  }]);
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
      // Short turns: all 8 fit in 30% of the context.
      assertEquals(await agent.restore(6), 8);
      // With no room to spare, still the last 6.
      assertEquals(await agent.restore(6, 0), 6);
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

Deno.test("fit drops the oldest steps of a turn too long to fit, keeping its latest", async () => {
  const { fit } = await import("../src/agent.ts");
  const history: any[] = [{ role: "user", content: "bring up TP4" }];
  for (let i = 0; i < 60; i++) {
    const call = {
      id: `c${i}`,
      type: "function",
      function: { name: "run", arguments: `{"command":"step ${i} ${"y".repeat(300)}"}` },
    };
    history.push({
      role: "assistant",
      content: `thinking about step ${i} ${"z".repeat(300)}`,
      tool_calls: [call],
    });
    history.push({ role: "tool", tool_call_id: `c${i}`, content: `out ${i} ${"x".repeat(300)}` });
  }
  const out = fit(history, 12_000, ["rebooting .93"]);
  const size = out.reduce((n, m) => n + JSON.stringify(m).length, 0);
  assert(size <= 12_000, `fits: ${size}`);
  assertEquals(out[0].role, "user");
  assertStringIncludes(out[0].content, "bring up TP4");
  assertStringIncludes(out[0].content, "oldest steps of this turn were dropped");
  assertStringIncludes(out[0].content, "rebooting .93");
  assertEquals(out[1].role, "assistant", "a step starts after the note");
  assertStringIncludes(out.at(-1)!.content, "out 59", "the latest step stays");
  // Every tool result still has its call.
  const ids = new Set(out.flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.id)));
  assert(out.every((m: any) => m.role !== "tool" || ids.has(m.tool_call_id)));
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

Deno.test("^C at a tool's approval prompt ends the turn", async () => {
  const { setFrontend, Interrupted } = await import("../src/frontend.ts");
  const lines: string[] = [];
  setFrontend({
    emit: (e: any) => e.type === "line" && lines.push(e.text),
    readLine: () => Promise.reject(new Interrupted()),
    close() {},
  });
  const { m, agent, done } = await session("gpt-oss-120b", [
    {
      calls: [{ name: "run", args: { command: "touch /tmp/aib-never" } }, {
        name: "run",
        args: { command: "ls" },
      }],
    },
    { content: "the model went on" },
  ]);
  try {
    (agent.s as any).allowReadonly = false;
    await agent.turn("go");
    assertEquals(m.seen.filter((b) => b.tools).length, 1, "no further model call");
    const tools = agent.history.filter((x) => x.role === "tool").map((x) => x.content);
    assertEquals(tools, [
      "not run: the user pressed ^C at the prompt",
      "not run: the user interrupted",
    ]);
    assertEquals(agent.history.at(-1)!.content, "(the user stopped that command)");
    assert(lines.includes("[interrupted]") || lines.some((l) => l.includes("[interrupted]")));
  } finally {
    await done();
  }
});

Deno.test("restored turns are shown, and an ssh hop left open is called interrupted", async () => {
  const { Transcript } = await import("../src/transcript.ts");
  const { setFrontend } = await import("../src/frontend.ts");
  const dir = await Deno.makeTempDir();
  const lines: string[] = [];
  setFrontend({
    emit: (e: any) => e.type === "line" && lines.push(e.text),
    readLine: () => Promise.resolve(null),
    close() {},
  });
  try {
    const path = join(dir, "t.jsonl");
    const before = new Transcript(path);
    const call = {
      id: "c1",
      type: "function" as const,
      function: { name: "ssh", arguments: '{"destination":"admin@gx10"}' },
    };
    before.append({ role: "user", content: "log in to the spark" }, "local");
    before.append({ role: "assistant", content: "", tool_calls: [call] }, "local");
    before.append(
      { role: "tool", tool_call_id: "c1", content: "connected." },
      "local > admin@gx10",
    );
    before.append({ role: "assistant", content: "I'm on the spark now." }, "local > admin@gx10");
    const { s, agent, done } = await session("gpt-oss-120b", [{ content: "ok" }]);
    try {
      s.transcript = new Transcript(path);
      assertEquals(await agent.restore(6), 1);
      assertEquals(agent.restoredFrom, "local > admin@gx10");
      await agent.showRestored();
      const plain = lines.map((l) =>
        l.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "")
      );
      assertEquals(plain, [
        "› log in to the spark",
        '  ssh {"destination":"admin@gx10"}',
        "● I'm on the spark now.",
      ]);
      const sys = (await agent.system())();
      assertStringIncludes(sys, "That connection was interrupted when the session was resumed");
      assertStringIncludes(sys, "local > admin@gx10");
      // A session that ended on the local machine says nothing about ssh.
      const earlier = new Transcript(join(dir, "u.jsonl"));
      earlier.append({ role: "user", content: "hi" }, "local");
      earlier.append({ role: "assistant", content: "hello" }, "local");
      s.transcript = new Transcript(join(dir, "u.jsonl"));
      await agent.restore(6);
      assertEquals(agent.restoredFrom, null);
      assert(!(await agent.system())().includes("connection was interrupted"));
    } finally {
      await done();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("whitespace before a tool call opens no empty reply; quiet tools say what they do", async () => {
  const { setFrontend } = await import("../src/frontend.ts");
  const events: any[] = [];
  setFrontend({
    emit: (e: any) => events.push(e),
    readLine: () => Promise.resolve(null),
    close() {},
  });
  const { agent, done } = await session("gpt-oss-120b", [
    { content: "\n\n", calls: [{ name: "memory_search", args: { query: "spark agent" } }] },
    { content: "\n  Found it." },
  ]);
  try {
    await agent.turn("continue working");
    const starts = events.filter((e) => e.type === "assistant" && e.phase === "start");
    assertEquals(starts.length, 1, "one reply, for the words");
    const text = events.filter((e) => e.type === "assistant" && e.phase === "delta").map((e) =>
      e.text
    )
      .join("");
    assertEquals(text, "Found it.");
    const lines = events.filter((e) => e.type === "line").map((e) =>
      e.text.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "")
    );
    assert(
      lines.some((l) => l.includes('searching memory and docs for "spark agent"')),
      lines.join("|"),
    );
  } finally {
    await done();
  }
});

Deno.test("an empty reply or an unreadable tool call is retried, not a silent stop", async () => {
  const { m, agent, done } = await session("gpt-oss-120b", [
    { content: "" },
    { content: "<tool_call>\n<function=run>\n<parameter=command>\nls" },
    { content: "<tool_call>{broken" },
    { content: "Here you go." },
  ]);
  try {
    await agent.turn("go");
    const asks = m.seen.filter((b) => b.tools);
    // The XML call was recovered and run; the broken one got a nudge.
    assertEquals(asks.length, 4);
    assertStringIncludes(asks[1].messages.at(-1).content, "Your last reply was empty");
    assertEquals(asks[2].messages.at(-1).role, "tool");
    assertStringIncludes(asks[3].messages.at(-1).content, "could not be parsed");
  } finally {
    await done();
  }
});

Deno.test("two nudges, then the turn stops with a warning", async () => {
  const { m, agent, done } = await session("gpt-oss-120b", [
    { content: "" },
    { content: "" },
    { content: "" },
    { content: "never reached" },
  ]);
  try {
    await agent.turn("go");
    assertEquals(m.seen.filter((b) => b.tools).length, 3);
  } finally {
    await done();
  }
});

Deno.test("active goals: shown by title, reminded with details every 3 turns or 10 tool calls", async () => {
  const { setFrontend } = await import("../src/frontend.ts");
  const shown: string[][] = [];
  setFrontend({
    emit(e) {
      if (e.type === "goals") shown.push(e.titles);
    },
    readLine: () => Promise.resolve(null),
    close() {},
  });
  Deno.env.set("AIBOOT_BACKOFF", "0");
  const calls = Array.from({ length: 10 }, () => ({ calls: [{ name: "plan", args: {} }] }));
  const { m, s, agent, done } = await session("gpt-oss-120b", [
    { content: "one" },
    { content: "two" },
    { content: "three" },
    ...calls,
    { content: "four" },
  ]);
  try {
    await s.memory.init();
    await s.memory.write(
      "goals.json",
      JSON.stringify([{ title: "Serve GLM", details: "secret-ish detail: port 41873" }]),
    );
    await agent.turn("a");
    assertEquals(shown.at(-1), ["Serve GLM"], "titles only, the first open goal made active");
    assert(!JSON.stringify(shown).includes("41873"), "details are never sent to the screen");
    await agent.turn("b");
    await agent.turn("c");
    const asks = m.seen.filter((b) => b.tools);
    const users = asks[2].messages.filter((x: any) => x.role === "user");
    assert(!users[0].content.includes("Reminder"));
    assertStringIncludes(users.at(-1).content, "Reminder: your active goals");
    assertStringIncludes(users.at(-1).content, "Serve GLM: secret-ish detail: port 41873");
    // The fourth turn makes 10 tool calls: the 10th result carries the reminder.
    await agent.turn("d");
    const tools = m.seen.at(-1).messages.filter((x: any) => x.role === "tool");
    assertEquals(tools.length, 10);
    assert(!tools[8].content.includes("Reminder"));
    assertStringIncludes(tools[9].content, "Reminder: your active goals");
  } finally {
    Deno.env.delete("AIBOOT_BACKOFF");
    await done();
  }
});

Deno.test('fit: after a long turn, "continue" keeps that turn\'s latest steps and what it was for', async () => {
  const { fit } = await import("../src/agent.ts");
  const call = (id: string) => ({
    id,
    type: "function" as const,
    function: { name: "run", arguments: `{"command":"step ${id}"}` },
  });
  const history: any[] = [
    { role: "user", content: "older, finished request" },
    { role: "assistant", content: "done with that" },
    { role: "user", content: "bring up GLM-5.3 TP4 on the sparks" },
  ];
  for (let i = 0; i < 60; i++) {
    history.push({ role: "assistant", content: "", tool_calls: [call(`c${i}`)] });
    history.push({
      role: "tool",
      tool_call_id: `c${i}`,
      content: `output ${i} ` + "y".repeat(500),
    });
  }
  history.push({ role: "user", content: "continue" });
  const out = fit(history, 12_000);
  assertEquals(out.at(-1)!.content, "continue");
  // The start of the long turn went, but a note keeps the request...
  assertEquals(out[0].role, "user");
  assertStringIncludes(out[0].content, "bring up GLM-5.3 TP4 on the sparks");
  assertStringIncludes(out[0].content, "history_search");
  // ...and its latest steps are still there, with every tool result after its call.
  assert(out.some((m) => m.content.startsWith("output 59")));
  assert(!out.some((m) => m.content.startsWith("output 0 ")));
  assertEquals(out[1].role, "assistant");
  for (const [i, m] of out.entries()) {
    if (m.role === "tool") assert(["assistant", "tool"].includes(out[i - 1].role));
  }
  const size = out.reduce(
    (n, m) => n + m.content.length + JSON.stringify(m.tool_calls ?? "").length,
    0,
  );
  assert(size <= 12_000, `fits: ${size}`);
});

Deno.test("update_status: shown while working, gone after 5 steps, kept in context through fit", async () => {
  const { setFrontend } = await import("../src/frontend.ts");
  const shown: (string | null)[] = [];
  setFrontend({
    emit(e) {
      if (e.type === "activity") shown.push(e.text);
    },
    readLine: () => Promise.resolve(null),
    close() {},
  });
  Deno.env.set("AIBOOT_BACKOFF", "0");
  const { m, agent, done } = await session("gpt-oss-120b", [
    { calls: [{ name: "update_status", args: { status: "vLLM up on spark-1; starting rank 2" } }] },
    ...Array.from({ length: 5 }, () => ({ calls: [{ name: "plan", args: {} }] })),
    { content: "done" },
  ]);
  try {
    await agent.turn("go");
    assertEquals(shown, ["vLLM up on spark-1; starting rank 2", null], "shown, then expired");
    // Not a tool the server sees run: answered "ok" in place.
    const last = m.seen.at(-1).messages;
    assertEquals(last.find((x: any) => x.role === "tool").content, "ok");
  } finally {
    Deno.env.delete("AIBOOT_BACKOFF");
    await done();
  }
});

Deno.test("fit: the latest statuses survive dropped steps", async () => {
  const { fit } = await import("../src/agent.ts");
  const call = (id: string) => ({
    id,
    type: "function" as const,
    function: { name: "run", arguments: "{}" },
  });
  const history: any[] = [{ role: "user", content: "bring up TP4" }];
  for (let i = 0; i < 40; i++) {
    history.push({ role: "assistant", content: "", tool_calls: [call(`c${i}`)] });
    history.push({ role: "tool", tool_call_id: `c${i}`, content: "z".repeat(500) });
  }
  history.push({ role: "user", content: "continue" });
  const statuses = ["ranks 0-1 up", "rank 2 fails: NCCL timeout"];
  const out = fit(history, 8000, statuses);
  assertStringIncludes(out[0].content, "- ranks 0-1 up\n- rank 2 fails: NCCL timeout");
  assertStringIncludes(out[0].content, "bring up TP4");
  // A whole turn dropped: the anchor rides on the next user message (roles alternate).
  const whole = fit(
    [
      { role: "user", content: "a" },
      { role: "assistant", content: "x".repeat(9000) },
      { role: "user", content: "next" },
    ],
    2000,
    statuses,
  );
  assertEquals(whole.length, 1);
  assertStringIncludes(whole[0].content, "rank 2 fails");
  assert(whole[0].content.endsWith("next"));
  // Nothing dropped: nothing added.
  assertEquals(fit(history.slice(0, 3), 1e6, statuses).length, 3);
});

Deno.test("an empty reply cut off by the output limit is retried with thinking off; nudges reset after a good step", async () => {
  Deno.env.set("AIBOOT_BACKOFF", "0");
  const bodies: any[] = [];
  const replies = [
    { finish: "length" },
    { call: true },
    { finish: "length" },
    { content: "done" },
  ];
  let i = 0;
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [] });
    const b = await req.json();
    if (!b.tools) {
      return new Response(
        `data: ${
          JSON.stringify({ choices: [{ delta: { content: "readonly" } }] })
        }\n\ndata: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    }
    bodies.push(b);
    const r = replies[Math.min(i++, replies.length - 1)];
    const delta = r.call
      ? { tool_calls: [{ index: 0, id: "c1", function: { name: "plan", arguments: "{}" } }] }
      : r.content
      ? { content: r.content }
      : { reasoning_content: "thinking about it" };
    const chunks = [{ choices: [{ delta }] }, {
      choices: [{ delta: {}, finish_reason: r.finish ?? "stop" }],
    }];
    return new Response(
      chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  });
  const dir = await Deno.makeTempDir();
  try {
    const s = new Session(
      new Router({
        label: "big",
        baseUrl: `http://127.0.0.1:${server.addr.port}/v1`,
        model: "gpt-oss-120b",
        contextChars: 400_000,
      }),
      new Memory(join(dir, "mem")),
      new McpManager(join(dir, "mcp.json")),
      () => Promise.resolve(null),
    );
    await s.init();
    await new Agent(s, () => "").turn("go");
    assertEquals(bodies.length, 4, "two empties, not in a row: the turn carries on");
    assertEquals(bodies[0].chat_template_kwargs, undefined, "thinking on by default");
    assertEquals(bodies[1].chat_template_kwargs, { enable_thinking: false, thinking: false });
    // The retry is handed where the cut-off thinking got to.
    const nudge = bodies[1].messages.at(-1);
    assertEquals(nudge.role, "user");
    assertStringIncludes(nudge.content, "ran out of room while thinking");
    assertStringIncludes(nudge.content, "thinking about it");
    assertEquals(bodies[2].chat_template_kwargs, undefined, "only the one retry");
    assertEquals(bodies[3].chat_template_kwargs, { enable_thinking: false, thinking: false });
    assert(bodies[0].max_tokens >= 2048, `room to answer: ${bodies[0].max_tokens}`);
  } finally {
    Deno.env.delete("AIBOOT_BACKOFF");
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a full history leaves room in the context for the reply", async () => {
  const { replyRoom } = await import("../src/agent.ts");
  const { m, agent, done } = await session("gpt-oss-120b", [{ content: "ok" }]);
  try {
    for (let i = 0; i < 40; i++) {
      agent.history.push({ role: "user", content: `q${i} ` + "x".repeat(2000) });
      agent.history.push({ role: "assistant", content: `a${i} ` + "y".repeat(2000) });
    }
    await agent.turn("go");
    const sent = m.seen.filter((b) => b.tools).at(-1);
    // contextChars is 40,000 in these sessions: a quarter stays free for the
    // reply. The history gets what the system prompt and the tools leave of
    // the rest (never less than 4,000 characters, so a tiny context still
    // carries the latest turn).
    assertEquals(replyRoom(40_000), 10_000);
    const fixed = sent.messages[0].content.length + JSON.stringify(sent.tools).length;
    const history = JSON.stringify(sent.messages.slice(1)).length;
    const budget = Math.max(40_000 - 10_000 - fixed, 4_000);
    assert(history <= budget + 2_000, `history uses ${history} of ${budget} characters`);
    assert(history < 40 * 4_000, "older turns were dropped");
  } finally {
    await done();
  }
});

Deno.test("text before and after a text-form tool call both reach the screen", async () => {
  const { setFrontend } = await import("../src/frontend.ts");
  const said: string[] = [];
  let cur = "";
  setFrontend({
    emit(e) {
      if (e.type !== "assistant") return;
      if (e.phase === "start") cur = "";
      else if (e.phase === "delta") cur += e.text ?? "";
      else said.push(cur);
    },
    readLine: () => Promise.resolve(null),
    close() {},
  });
  const { agent, done } = await session("gpt-oss-120b", [
    {
      content:
        'Checking the plan first. <tool_call>{"name": "update_status", "arguments": {"status": "x"}}</tool_call> Then I will look at the sparks.',
    },
    { content: "Done." },
  ]);
  try {
    await agent.turn("go");
    assertEquals(said.map((x) => x.trim()), [
      "Checking the plan first.",
      "Then I will look at the sparks.",
      "Done.",
    ]);
  } finally {
    await done();
  }
});

Deno.test("after a quiet stretch, the model sums up its recent steps (thinking off, no tools) as an update", async () => {
  const { setFrontend } = await import("../src/frontend.ts");
  const { UPDATE_PROMPT } = await import("../src/agent.ts");
  const said: string[] = [];
  let cur = "";
  setFrontend({
    emit(e) {
      if (e.type !== "assistant") return;
      if (e.phase === "start") cur = "";
      else if (e.phase === "delta") cur += e.text ?? "";
      else said.push(cur);
    },
    readLine: () => Promise.resolve(null),
    close() {},
  });
  Deno.env.set("AIBOOT_UPDATE_AFTER_MS", "0");
  Deno.env.set("AIBOOT_BACKOFF", "0");
  const step = { calls: [{ name: "update_status", args: { status: "checking rank 2" } }] };
  const { m, agent, done } = await session("gpt-oss-120b", [step, step, step, {
    content: "Done.",
  }]);
  try {
    await agent.turn("bring up TP4");
    const asks = m.seen.filter((b) => b.messages?.[0]?.content?.startsWith(UPDATE_PROMPT));
    assertEquals(asks.length, 1, "one update after two quiet steps");
    assertEquals(asks[0].tools, undefined, "no tools");
    assertEquals(asks[0].chat_template_kwargs, { enable_thinking: false, thinking: false });
    assertStringIncludes(asks[0].messages[1].content, "The user asked: bring up TP4");
    assertStringIncludes(asks[0].messages[1].content, "update_status");
    // The mock answers "ok": shown as an update block, and the work carried on.
    assertEquals(said, ["ok", "Done."]);
    const work = m.seen.filter((b) => b.tools);
    assertEquals(work.at(-1).chat_template_kwargs, undefined, "thinking back on for the work");
  } finally {
    Deno.env.delete("AIBOOT_UPDATE_AFTER_MS");
    Deno.env.delete("AIBOOT_BACKOFF");
    await done();
  }
});

Deno.test("at the step limit, the latest steps are summed up for the user and kept for continue", async () => {
  const { STOPPED_PROMPT } = await import("../src/agent.ts");
  Deno.env.set("AIBOOT_MAX_STEPS", "2");
  Deno.env.set("AIBOOT_UPDATES", "0");
  Deno.env.set("AIBOOT_BACKOFF", "0");
  const step = { calls: [{ name: "update_status", args: { status: "checking rank 2" } }] };
  const { m, agent, done } = await session("gpt-oss-120b", [step, step]);
  try {
    await agent.turn("bring up TP4");
    const asks = m.seen.filter((b) => b.messages?.[0]?.content?.startsWith(STOPPED_PROMPT));
    assertEquals(asks.length, 1);
    assertEquals(asks[0].tools, undefined, "no tools");
    assertStringIncludes(asks[0].messages[1].content, "The user asked: bring up TP4");
    assertStringIncludes(asks[0].messages[1].content, "checking rank 2");
    const last = agent.history.at(-1)!;
    assertEquals(last.role, "assistant");
    assertStringIncludes(String(last.content), "Stopped at the step limit");
  } finally {
    Deno.env.delete("AIBOOT_MAX_STEPS");
    Deno.env.delete("AIBOOT_UPDATES");
    Deno.env.delete("AIBOOT_BACKOFF");
    await done();
  }
});

Deno.test("a message typed while the model works is read after the latest tool results", async () => {
  const { steer } = await import("../src/frontend.ts");
  Deno.env.set("AIBOOT_BACKOFF", "0");
  const { m, agent, done } = await session("gpt-oss-120b", [
    { calls: [{ name: "update_status", args: { status: "starting rank 0" } }] },
    { content: "Using port 9000." },
  ]);
  try {
    steer("use port 9000, not 8000");
    await agent.turn("bring up the server");
    const asks = m.seen.filter((b) => b.tools);
    // Not in the first request (it was queued before any step ran)...
    assert(!JSON.stringify(asks[0].messages).includes("port 9000"));
    // ...but right after the tool result in the next.
    const msgs = asks[1].messages;
    const at = msgs.findIndex((x: any) => x.role === "user" && x.content.includes("use port 9000"));
    assert(at > 0, "steering message present");
    assertEquals(msgs[at - 1].role, "tool");
    assertStringIncludes(msgs[at].content, "While you were working, the user wrote");
    assertEquals(agent.interrupted, false);
  } finally {
    Deno.env.delete("AIBOOT_BACKOFF");
    await done();
  }
});
