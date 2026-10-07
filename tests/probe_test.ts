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
