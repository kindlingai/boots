// A tiny stdio MCP server with one tool, for tests.
import { TextLineStream } from "@std/streams";

const out = (m: unknown) => Deno.stdout.write(new TextEncoder().encode(JSON.stringify(m) + "\n"));
const lines = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).pipeThrough(
  new TextLineStream(),
);
for await (const line of lines) {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    await out({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "t", version: "1" },
      },
    });
  } else if (m.method === "tools/list") {
    await out({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        tools: [{
          name: "add",
          description: "Add two numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
        }],
      },
    });
  } else if (m.method === "tools/call") {
    const { a, b } = m.params.arguments;
    await out({
      jsonrpc: "2.0",
      id: m.id,
      result: { content: [{ type: "text", text: String(a + b) }] },
    });
  }
}
