import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { McpManager } from "../src/mcp.ts";

Deno.test("stdio MCP: list and call", async () => {
  const d = await Deno.makeTempDir();
  const m = new McpManager(join(d, "mcp.json"));
  await m.add("calc", {
    command: Deno.execPath(),
    args: ["run", "-A", new URL("./fixtures/mcp_server.ts", import.meta.url).pathname],
  });
  try {
    assertStringIncludes(await m.list(), "add: Add two numbers");
    assertEquals(await m.call("calc", "add", { a: 2, b: 40 }), "42");
    assertStringIncludes(await Deno.readTextFile(join(d, "mcp.json")), '"calc"');
  } finally {
    await m.closeAll();
  }
});
