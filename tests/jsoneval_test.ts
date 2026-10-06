// json_eval: edits in a sandbox that can do nothing but compute.
import { join } from "@std/path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { jsonEval } from "../src/jsoneval.ts";
import { Router } from "../src/llm.ts";
import { Memory } from "../src/memory.ts";
import { McpManager } from "../src/mcp.ts";
import { Session } from "../src/tools.ts";

Deno.test("json_eval: change in place, replace, input and console output", async () => {
  const doc = { hosts: { "spark-1": { models: [{ name: "glm53" }] } } };
  const r = await jsonEval(
    doc,
    { name: "qwen3" },
    "json.hosts['spark-1'].models.push(input); console.log('n', json.hosts['spark-1'].models.length)",
  );
  assertEquals(r.error, undefined);
  assertEquals(r.json, {
    hosts: { "spark-1": { models: [{ name: "glm53" }, { name: "qwen3" }] } },
  });
  assertEquals(r.logs, ["n 2"]);
  const swap = await jsonEval(doc, null, "json = { hosts: {} }");
  assertEquals(swap.json, { hosts: {} });
});

Deno.test("json_eval: no files, network, processes or environment", async () => {
  for (
    const code of [
      "Deno.readTextFileSync('/etc/hostname')",
      "Deno.writeTextFileSync('/tmp/aiboot-escape', 'x')",
      "new Deno.Command('true').outputSync()",
      "Deno.env.get('HOME')",
      "Deno.listen({ port: 0 })",
    ]
  ) {
    const r = await jsonEval({}, null, code);
    assert(r.error, `${code} should fail`);
    assertEquals(r.json, undefined);
  }
});

Deno.test("json_eval: errors, endless loops and non-JSON results save nothing", async () => {
  assertStringIncludes((await jsonEval({}, null, "json.a.b.c = 1")).error!, "TypeError");
  assertStringIncludes((await jsonEval({}, null, "while (true) {}", 1500)).error!, "timed out");
  assertStringIncludes((await jsonEval({}, null, "json = undefined")).error!, "undefined");
  const cyc = await jsonEval({}, null, "json.self = json");
  assertStringIncludes(cyc.error!, "circular");
});

Deno.test("the json_eval tool saves fleet.json", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const memory = new Memory(join(dir, "mem"));
    await memory.init();
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "big", contextChars: 1e4 }),
      memory,
      new McpManager(join(dir, "mcp.json")),
      () => Promise.resolve(null),
    );
    const out = await s.exec("json_eval", {
      code: "json.hosts = json.hosts ?? {}; json.hosts[input.host] = { models: [] }",
      input: { host: "spark-2" },
    });
    assertStringIncludes(out, "fleet.json saved");
    assertEquals(JSON.parse(await memory.fleet()), { hosts: { "spark-2": { models: [] } } });
    // A result that is not an object is refused by the memory, and nothing changes.
    assertStringIncludes(await s.exec("json_eval", { code: "json = [1, 2]" }), "not saved");
    assertEquals(JSON.parse(await memory.fleet()), { hosts: { "spark-2": { models: [] } } });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("json_eval edits goals.json, and its shape is enforced", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const memory = new Memory(join(dir, "mem"));
    await memory.init();
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "big", contextChars: 1e4 }),
      memory,
      new McpManager(join(dir, "mcp.json")),
      () => Promise.resolve(null),
    );
    assertStringIncludes(
      await s.exec("json_eval", {
        memory: "goals.json",
        code: "json.push({ title: input })",
        input: "Serve GLM",
      }),
      "goals.json saved",
    );
    assertStringIncludes(
      await s.exec("json_eval", { memory: "goals.json", code: "json[0].done = 'yes'" }),
      "goals[0].done must be true or false",
    );
    assertEquals(JSON.parse(await memory.goals()), [{ title: "Serve GLM" }]);
    assertStringIncludes(
      await s.exec("json_eval", { memory: "notes", code: "" }),
      "JSON memories only",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
