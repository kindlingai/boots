import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { chat, type Endpoint, normalize, Router } from "../src/llm.ts";
import { sizeFromName } from "../src/discover.ts";
import { serveMock } from "./fixtures/mock_llm.ts";

const ep = (url: string, label = "m"): Endpoint => ({
  label,
  baseUrl: url,
  model: label,
  contextChars: 40000,
});

Deno.test("streams content and reassembles tool calls", async () => {
  const m = serveMock([{
    content: "checking the GPU",
    calls: [{ name: "run", args: { command: "nvidia-smi -L" } }],
  }]);
  try {
    let streamed = "";
    const r = await chat(ep(m.url), [{ role: "user", content: "hi" }], [{
      type: "function",
      function: { name: "run", description: "", parameters: {} },
    }], {
      content: (t) => (streamed += t),
    });
    assertEquals(r.content, "checking the GPU");
    assertEquals(streamed, "checking the GPU");
    assertEquals(r.toolCalls.length, 1);
    assertEquals(JSON.parse(r.toolCalls[0].function.arguments), { command: "nvidia-smi -L" });
  } finally {
    await m.close();
  }
});

Deno.test("recovers <tool_call> text and strips <think>", () => {
  const n = normalize(
    '<think>hmm</think>Sure.\n<tool_call>\n{"name": "run", "arguments": {"command": "ls"}}\n</tool_call>',
    [],
  );
  assertEquals(n.content, "Sure.");
  assertEquals(n.reasoning, "hmm");
  assertEquals(n.calls[0].function.name, "run");
  assertEquals(JSON.parse(n.calls[0].function.arguments), { command: "ls" });
});

Deno.test("router falls back to the bootstrap model", async () => {
  const smart = serveMock(["down"]);
  const boot = serveMock([{ content: "from bootstrap" }]);
  try {
    const r = new Router(ep(boot.url, "boot"));
    r.setSmart(ep(smart.url, "smart"));
    let notice = "";
    r.onNotice = (s) => (notice = s);
    const reply = await r.chat(() => [{ role: "user", content: "x" }], [{
      type: "function",
      function: { name: "t", description: "", parameters: {} },
    }], {});
    assertEquals(reply.content, "from bootstrap");
    assertStringIncludes(notice, "falling back");
    assertEquals(r.current().label, "boot");
    assertEquals(r.usingFallback(), true);
  } finally {
    await smart.close();
    await boot.close();
  }
});

Deno.test("model sizes from names", () => {
  assertEquals(sizeFromName("qwen3:4b"), 4);
  assertEquals(sizeFromName("Qwen3-30B-A3B-Instruct"), 30);
  assertEquals(sizeFromName("mixtral-8x7b"), 56);
  assertEquals(sizeFromName("smol-360m"), 0.36);
  assertEquals(sizeFromName("llama"), 0);
});

Deno.test("a server that rejects tool_choice is asked again without it", async () => {
  const bodies: any[] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const b = await req.json();
    bodies.push(b);
    if (b.tool_choice) return new Response("tool_choice not supported", { status: 400 });
    const sse = `data: ${
      JSON.stringify({ choices: [{ delta: { content: "fine" } }] })
    }\n\ndata: [DONE]\n\n`;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const ep = {
      label: "x",
      baseUrl: `http://127.0.0.1:${server.addr.port}/v1`,
      model: "x",
      contextChars: 1e4,
    };
    const tool = {
      type: "function" as const,
      function: { name: "t", description: "", parameters: { type: "object", properties: {} } },
    };
    const r = await chat(
      ep,
      [{ role: "user", content: "hi" }],
      [tool],
      {},
      undefined,
      0,
      "required",
    );
    assertEquals(r.content, "fine");
    assertEquals(bodies.map((b) => b.tool_choice), ["required", undefined]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("handover: the bootstrap stops for the full model and comes back when it fails", async () => {
  const { Router } = await import("../src/llm.ts");
  const { serveMock } = await import("./fixtures/mock_llm.ts");
  const small = serveMock([{ content: "small here" }]);
  let up = true;
  let starts = 0;
  const ep = (url: string, model: string) => ({
    label: model,
    baseUrl: url,
    model,
    contextChars: 1e4,
  });
  const r = new Router(ep(small.url, "small-4b"), {
    running: () => up,
    stop: () => {
      up = false;
      return Promise.resolve();
    },
    start: () => {
      up = true;
      starts++;
      return Promise.resolve(ep(small.url, "small-4b"));
    },
  });
  try {
    assertEquals(await r.handover(), true);
    assertEquals(r.bootstrapUp(), false);
    assertEquals(await r.handover(), false, "already handed over");
    // The full model is down: asking falls back, which starts the small model again.
    r.setSmart(ep("http://127.0.0.1:9/v1", "big-30b"));
    const tool = {
      type: "function" as const,
      function: { name: "t", description: "", parameters: { type: "object", properties: {} } },
    };
    const reply = await r.chat(() => [{ role: "user", content: "hi" }], [tool], {});
    assertEquals(reply.content, "small here");
    assertEquals(starts, 1);
    assertEquals(r.bootstrapUp(), true);
  } finally {
    await small.close();
  }
});

Deno.test("sampling: none unless the endpoint asks; a server that rejects it is asked again", async () => {
  const bodies: any[] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const b = await req.json();
    bodies.push(b);
    if ("temperature" in b || "top_p" in b) {
      return new Response("unsupported sampling parameter: temperature", { status: 400 });
    }
    const sse = `data: ${
      JSON.stringify({ choices: [{ delta: { content: "ok" } }] })
    }\n\ndata: [DONE]\n\n`;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const ep = {
      label: "x",
      baseUrl: `http://127.0.0.1:${server.addr.port}/v1`,
      model: "x",
      contextChars: 1e4,
    };
    const hi = [{ role: "user" as const, content: "hi" }];
    assertEquals((await chat(ep, hi, [])).content, "ok");
    assertEquals(bodies.length, 1);
    assert(!("temperature" in bodies[0]), "a remote model gets the server's defaults");

    bodies.length = 0;
    const tuned = { ...ep, sampling: { temperature: 0.7, top_p: 0.8 } };
    assertEquals((await chat(tuned, hi, [])).content, "ok");
    assertEquals(bodies[0].temperature, 0.7);
    assertEquals(bodies[0].top_p, 0.8);
    assert(!("temperature" in bodies[1]) && !("top_p" in bodies[1]), "retried without them");
  } finally {
    await server.shutdown();
  }
});

Deno.test("the context a server declares, or a 128k in the name", async () => {
  const { declaredContext } = await import("../src/discover.ts");
  assertEquals(declaredContext({ id: "qwen36-a3b-128k", max_model_len: 131072 }), 131072);
  assertEquals(declaredContext({ id: "x", context_length: 200000 }), 200000);
  assertEquals(declaredContext({ id: "x", meta: { n_ctx_train: 32768 } }), 32768);
  assertEquals(declaredContext({ id: "qwen36-a3b-128k" }), 131072);
  assertEquals(declaredContext({ id: "qwen3-8b" }), 0);
});

Deno.test("a template that wants tool-call arguments as a mapping gets objects from then on", async () => {
  const bodies: any[] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const b = await req.json();
    bodies.push(b);
    const strArgs = b.messages.some((m: any) =>
      m.tool_calls?.some((c: any) => typeof c.function.arguments === "string")
    );
    if (strArgs) {
      return Response.json({ error: { message: "Can only get item pairs from a mapping." } }, {
        status: 400,
      });
    }
    const sse = `data: ${
      JSON.stringify({ choices: [{ delta: { content: "ok" } }] })
    }\n\ndata: [DONE]\n\n`;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const ep: Endpoint = {
      label: "mlx",
      baseUrl: `http://127.0.0.1:${server.addr.port}/v1`,
      model: "x",
      contextChars: 1e4,
    };
    const msgs = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [{
          id: "c1",
          type: "function" as const,
          function: { name: "run", arguments: '{"command":"ls"}' },
        }],
      },
      { role: "tool" as const, tool_call_id: "c1", content: "out" },
    ];
    assertEquals((await chat(ep, msgs, [])).content, "ok");
    assertEquals(ep.toolArgsAsObjects, true);
    assertEquals(bodies[1].messages[1].tool_calls[0].function.arguments, { command: "ls" });
    bodies.length = 0;
    await chat(ep, msgs, []);
    assertEquals(bodies.length, 1, "no failed attempt the second time");
    assertEquals(
      msgs[1].tool_calls![0].function.arguments,
      '{"command":"ls"}',
      "history untouched",
    );
  } finally {
    await server.shutdown();
  }
});
