// A scripted OpenAI-compatible server. Each tool-bearing request takes the
// next scripted reply; requests without tools (liveness pings) get "ok".
// Replies stream as SSE with tool-call deltas split across chunks.

export type Scripted = { content?: string; calls?: { name: string; args: unknown }[] } | "down";

/**
 * `classify`, when given, answers the command checker (src/classify.ts):
 * it gets the command and returns the reply.
 */
export function serveMock(script: Scripted[], port = 0, classify?: (cmd: string) => string) {
  const seen: any[] = [];
  let i = 0;
  const server = Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "mock-30b" }] });
    const body = await req.json();
    seen.push(body);
    const delay = Number(Deno.env.get("MOCK_DELAY_MS") ?? 0);
    if (delay && body.tools) await new Promise((r) => setTimeout(r, delay));
    const last = body.messages?.at(-1);
    if (last?.role === "tool" && Deno.env.get("MOCK_LOG")) console.error(`tool> ${last.content}`);
    if (body.tools && Deno.env.get("MOCK_SYSTEM") && body.messages?.[0]?.role === "system") {
      console.error(`system> ${body.messages[0].content}`);
    }
    const sys = body.messages?.[0]?.content ?? "";
    if (!body.tools && classify && sys.startsWith("You check shell commands")) {
      const cmd = (body.messages.at(-1).content.match(/```\n([\s\S]*)\n```/) ?? [])[1] ?? "";
      return sse([{ choices: [{ delta: { content: classify(cmd) } }] }]);
    }
    if (!body.tools) return sse([{ choices: [{ delta: { content: "ok" } }] }]);
    const r = script[Math.min(i++, script.length - 1)];
    if (r === "down") return new Response("overloaded", { status: 503 });
    const chunks: any[] = [];
    if (r.content) {
      for (const part of r.content.match(/.{1,7}/gs) ?? []) {
        chunks.push({ choices: [{ delta: { content: part } }] });
      }
    }
    (r.calls ?? []).forEach((c, idx) => {
      const args = JSON.stringify(c.args);
      chunks.push({
        choices: [{
          delta: {
            tool_calls: [{
              index: idx,
              id: `c${i}_${idx}`,
              function: { name: c.name, arguments: "" },
            }],
          },
        }],
      });
      chunks.push({
        choices: [{
          delta: { tool_calls: [{ index: idx, function: { arguments: args.slice(0, 5) } }] },
        }],
      });
      chunks.push({
        choices: [{
          delta: { tool_calls: [{ index: idx, function: { arguments: args.slice(5) } }] },
        }],
      });
    });
    chunks.push({
      choices: [{ delta: {}, finish_reason: r.calls?.length ? "tool_calls" : "stop" }],
    });
    return sse(chunks);
  });
  return { url: `http://127.0.0.1:${server.addr.port}/v1`, seen, close: () => server.shutdown() };
}

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

if (import.meta.main) {
  // deno run -A tests/fixtures/mock_llm.ts SCRIPT.json PORT
  const script = JSON.parse(await Deno.readTextFile(Deno.args[0]));
  const verdict = Deno.env.get("MOCK_VERDICT");
  const m = serveMock(script, Number(Deno.args[1] ?? 0), verdict ? () => verdict : undefined);
  console.log(m.url);
}
