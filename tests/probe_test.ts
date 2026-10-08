// Probing an endpoint for how it thinks, and using what it found.
import { assert, assertEquals } from "@std/assert";
import { applyProfile, probe } from "../src/probe.ts";
import { chat, type Endpoint } from "../src/llm.ts";

/**
 * A server like a hybrid thinking model: by default it thinks at length,
 * chat_template_kwargs turns that off, and reasoning_effort (top level) makes
 * it think less. Every answer is right except when it thinks not at all.
 */
function server() {
  const seen: any[] = [];
  const s = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const b = await req.json();
    seen.push(b);
    const off = b.chat_template_kwargs?.enable_thinking === false;
    const effort = b.reasoning_effort;
    const reasoning = off
      ? ""
      : effort === "low"
      ? "r".repeat(400)
      : effort === "medium"
      ? "r".repeat(2000)
      : "r".repeat(12000);
    // Thinking long is slow.
    if (reasoning.length > 5000) await new Promise((r) => setTimeout(r, 300));
    const content = off ? "6:15 pm" : "6:15 pm";
    if (b.stream) {
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      choices: [{
        message: {
          content: b.max_tokens <= 8 ? "6:15" : content,
          reasoning_content: reasoning,
        },
      }],
    });
  });
  return { s, seen, url: `http://127.0.0.1:${(s.addr as Deno.NetAddr).port}/v1` };
}

Deno.test("probe: picks the cheapest right thinking setting and a way to turn thinking off", async () => {
  const { s, seen, url } = server();
  try {
    const ep: Endpoint = { label: "m", baseUrl: url, model: "m", contextChars: 400_000 };
    const p = await probe(ep, () => undefined);
    assertEquals(p.features.thinksByDefault, true);
    assertEquals(p.features.templateKwargsOff, true);
    assertEquals(p.features.reasoningEffort, "top-level");
    assertEquals(p.thinking.params, { reasoning_effort: "low" }, "least thinking that is right");
    assertEquals(p.nonThinking.params, {
      chat_template_kwargs: { enable_thinking: false, thinking: false },
    });
    assert(p.probeMs < 30_000 && p.trials.length >= 4);
    assert(p.timeouts.nonThinkingMs >= 30_000);
    // Used: normal requests take the thinking setting, thinking-off ones the other.
    applyProfile(ep, p);
    seen.length = 0;
    await chat(ep, [{ role: "user", content: "x" }], []);
    assertEquals(seen[0].reasoning_effort, "low");
    assertEquals(seen[0].chat_template_kwargs, undefined);
    await chat(
      ep,
      [{ role: "user", content: "x" }],
      [],
      {},
      undefined,
      undefined,
      undefined,
      false,
      true,
    );
    assertEquals(seen[1].chat_template_kwargs, { enable_thinking: false, thinking: false });
    assertEquals(seen[1].reasoning_effort, undefined);
  } finally {
    await s.shutdown();
  }
});

Deno.test("probe: stays within its budget and never throws on a dead server", async () => {
  const ep: Endpoint = {
    label: "x",
    baseUrl: "http://127.0.0.1:9/v1",
    model: "x",
    contextChars: 1e5,
  };
  const t0 = Date.now();
  const p = await probe(ep, () => undefined, () => {}, 3000);
  assert(Date.now() - t0 < 5000);
  assertEquals(p.thinking.params, {});
  assertEquals(p.nonThinking.params, {});
  assert(p.trials.every((t) => !t.accepted));
});

/**
 * A server like GLM-5.3-Flash: it always thinks (chat_template_kwargs is
 * taken but ignored), takes reasoning_effort low, high or max, and refuses
 * anything else, saying which it takes.
 */
function alwaysThinking() {
  const seen: any[] = [];
  const REFUSAL = JSON.stringify({
    error: {
      code: "1210",
      message:
        "This model always engages in thinking and cannot be disabled; please use low, high, or max",
    },
  });
  const s = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const b = await req.json();
    seen.push(b);
    const effort = b.reasoning_effort;
    if (effort !== undefined && !["low", "high", "max"].includes(effort)) {
      return new Response(REFUSAL, { status: 400 });
    }
    if (b.chat_template_kwargs?.enable_thinking === false && b.stream) {
      return new Response(REFUSAL, { status: 400 });
    }
    const reasoning = effort === "low" ? "r".repeat(200) : "r".repeat(effort ? 1600 : 800);
    if (b.stream) {
      return new Response(
        `data: ${
          JSON.stringify({ choices: [{ delta: { content: "6:15 pm" } }] })
        }\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      choices: [{ message: { content: "6:15 pm", reasoning_content: reasoning } }],
    });
  });
  return { s, seen, url: `http://127.0.0.1:${(s.addr as Deno.NetAddr).port}/v1` };
}

Deno.test("probe: a model that always thinks, and takes only some reasoning levels", async () => {
  const { s, seen, url } = alwaysThinking();
  try {
    const ep: Endpoint = { label: "glm", baseUrl: url, model: "glm", contextChars: 400_000 };
    const p = await probe(ep, () => undefined);
    assertEquals(p.features.alwaysThinks, true);
    assertEquals(p.features.templateKwargsOff, false);
    assertEquals(p.features.efforts, ["low", "high", "max"]);
    assert(p.trials.some((t) => t.name === "effort high" && t.accepted), "high tried for medium");
    assertEquals(p.nonThinking.params, { reasoning_effort: "low" }, "its least thinking");
    applyProfile(ep, p);
    assertEquals(ep.alwaysThinks, true);
    // Thinking off: never the refused switch, only the lightest level.
    seen.length = 0;
    await chat(
      ep,
      [{ role: "user", content: "x" }],
      [],
      {},
      undefined,
      undefined,
      undefined,
      false,
      true,
    );
    assertEquals(seen[0].reasoning_effort, "low");
    assertEquals(seen[0].chat_template_kwargs, undefined);
  } finally {
    await s.shutdown();
  }
});

Deno.test("chat: learns from a refusal that a model always thinks, and which levels it takes", async () => {
  const { listedEfforts, nearestEffort } = await import("../src/llm.ts");
  assertEquals(
    listedEfforts("cannot be disabled; please use low, high, or max"),
    ["low", "high", "max"],
  );
  assertEquals(listedEfforts("must be one of: 'minimal', 'low', 'medium', 'high'"), [
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  assertEquals(listedEfforts("please use a different model"), null);
  assertEquals(nearestEffort("medium", ["low", "high", "max"]), "high");
  assertEquals(nearestEffort("xhigh", ["low", "high"]), "high");
  const { s, seen, url } = alwaysThinking();
  try {
    // Not probed: /thinking off sends the usual switch, is refused, and is
    // not sent again; a level it does not take is moved to the next one up.
    const ep: Endpoint = { label: "glm", baseUrl: url, model: "glm", contextChars: 400_000 };
    const r = await chat(
      ep,
      [{ role: "user", content: "x" }],
      [],
      {},
      undefined,
      undefined,
      undefined,
      false,
      true,
    );
    assertEquals(r.content, "6:15 pm");
    assertEquals(ep.alwaysThinks, true);
    assertEquals(ep.efforts, ["low", "high", "max"]);
    assertEquals(seen.at(-1).chat_template_kwargs, undefined);
    ep.profile = { thinking: { reasoning_effort: "medium" }, nonThinking: {} };
    seen.length = 0;
    await chat(ep, [{ role: "user", content: "x" }], []);
    assertEquals(seen.length, 1, "asked once, at a level it takes");
    assertEquals(seen[0].reasoning_effort, "high");
  } finally {
    await s.shutdown();
  }
});
