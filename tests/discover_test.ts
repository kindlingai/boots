import { assertEquals } from "@std/assert";
import { pinnedEndpoint } from "../src/discover.ts";

Deno.test("OPENAI_BASE_URL pins one endpoint: its first model and its declared context", async () => {
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen() {} }, (req) => {
    if (new URL(req.url).pathname === "/v1/models") {
      return Response.json({ data: [{ id: "glm-5.3", max_model_len: 131072 }, { id: "other" }] });
    }
    return new Response("no", { status: 404 });
  });
  const base = `http://127.0.0.1:${server.addr.port}/v1/`;
  const saved = ["OPENAI_BASE_URL", "OPENAI_URL", "OPENAI_MODEL", "OPENAI_API_KEY"].map(
    (k) => [k, Deno.env.get(k)] as const,
  );
  try {
    for (const [k] of saved) Deno.env.delete(k);
    assertEquals(await pinnedEndpoint(), null, "nothing given, nothing pinned");
    Deno.env.set("OPENAI_URL", base);
    const ep = (await pinnedEndpoint())!;
    assertEquals(ep.baseUrl, base.replace(/\/$/, ""));
    assertEquals(ep.model, "glm-5.3");
    assertEquals(ep.contextChars, 131072 * 3);
    Deno.env.set("OPENAI_MODEL", "other");
    assertEquals((await pinnedEndpoint())!.model, "other", "OPENAI_MODEL wins");
  } finally {
    for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    ac.abort();
    await server.finished;
  }
});
