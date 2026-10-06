// The bundled knowledge base: every doc ships, search finds it, and the
// model reaches it through the memory_search tool call.
//
// AIBOOT_BIN=dist/ai-bootstrap runs the same checks against a compiled
// binary, proving the docs are embedded in it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { serveMock } from "./fixtures/mock_llm.ts";

const EXPECTED = [
  "docker",
  "intermediate-linux",
  "intermediate-macos",
  "intermediate-windows",
  "llama-cpp",
  "mentat",
  "models-deepseek",
  "models-gemma",
  "models-glm",
  "models-kimi",
  "models-others",
  "models-qwen",
  "ollama",
  "ray",
  "sglang",
  "tensorfold",
  "vllm",
];

const bin = Deno.env.get("AIBOOT_BIN");
const argv = bin
  ? [bin]
  : [Deno.execPath(), "run", "-A", fromFileUrl(new URL("../src/main.ts", import.meta.url))];

async function run(args: string[], env: Record<string, string> = {}, stdin = "") {
  const home = await Deno.makeTempDir();
  const p = new Deno.Command(argv[0], {
    args: [...argv.slice(1), ...args],
    // Run away from the repo so only embedded docs can be found.
    cwd: home,
    env: { AIBOOT_HOME: `${home}/data`, AIBOOT_CACHE: `${home}/cache`, NO_COLOR: "1", ...env },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(stdin));
  await w.close();
  const o = await p.output();
  const d = new TextDecoder();
  return { code: o.code, out: d.decode(o.stdout), err: d.decode(o.stderr) };
}

Deno.test("every knowledge-base doc ships", async () => {
  const r = await run(["--docs"]);
  assertEquals(r.out.trim().split("\n"), EXPECTED.map((n) => `docs/${n}`));
});

Deno.test("search finds each topic, by whole words", async () => {
  for (
    const [q, want] of [
      ["ray", "docs/ray:"],
      ["mentat router", "docs/mentat:"],
      ["tensorfold metal", "docs/tensorfold:"],
      ["dgx spark", "docs/intermediate-linux:"],
      ["strix halo", "docs/intermediate-linux:"],
      ["wsl vllm", "docs/intermediate-windows:"],
      ["mlx", "docs/intermediate-macos:"],
      ["nvidia container toolkit", "docs/docker:"],
      ["OLLAMA_CONTEXT_LENGTH", "docs/ollama:"],
      ["enable-auto-tool-choice hermes", "docs/vllm:"],
      ["qwen3.8", "docs/models-qwen:"],
      ["glm-5.3-flash", "docs/models-glm:"],
      ["kimi k3", "docs/models-kimi:"],
      ["deepseek-v4-flash", "docs/models-deepseek:"],
      ["diffusiongemma", "docs/models-gemma:"],
      ["harmony gpt-oss", "docs/models-others:"],
    ]
  ) {
    const r = await run(["--search", ...q.split(" ")]);
    assertEquals(r.code, 0, `${q}: ${r.err}`);
    const top = r.out.split("\n").slice(0, 3);
    assert(top.some((l) => l.startsWith(want)), `${q} → ${top.join(" | ")}`);
  }
});

Deno.test("the model reaches the knowledge base through memory_search", async () => {
  const m = serveMock([
    { calls: [{ name: "memory_search", args: { query: "ray multi-node" } }] },
    { calls: [{ name: "memory_read", args: { name: "docs/mentat" } }] },
    { content: "done" },
  ]);
  try {
    const r = await run(
      [],
      { OPENAI_BASE_URL: m.url, OPENAI_MODEL: "mock" },
      "1\nhelp me\n/quit\n",
    );
    assertEquals(r.code, 0, r.out + r.err);
    const last = m.seen.filter((b) => b.tools).at(-1).messages;
    const tools = last.filter((x: any) => x.role === "tool");
    assertStringIncludes(tools[0].content, "docs/ray:");
    assertStringIncludes(tools[1].content, "kindlingai/mentat");
    // The system prompt names the knowledge base.
    const sys = m.seen.find((b) => b.tools)?.messages[0].content ?? "";
    assertStringIncludes(sys, "tensorfold");
  } finally {
    await m.close();
  }
});

Deno.test("on the base model the session opens by asking to set up a smarter one", async () => {
  const m = serveMock([{ content: "I'm running on my base intelligence layer right now..." }]);
  try {
    // No task typed: the model speaks first.
    const r = await run([], { OPENAI_BASE_URL: m.url, OPENAI_MODEL: "qwen3-4b" }, "1\n/quit\n");
    assertEquals(r.code, 0, r.out + r.err);
    assert(!r.out.includes("What would you like to do?"), r.out);
    assertStringIncludes(r.out, "base intelligence layer");
    const sys = m.seen.find((b) => b.tools)?.messages[0].content ?? "";
    assertStringIncludes(sys, "Is it OK if I check your system and start that process?");
  } finally {
    await m.close();
  }
});

Deno.test("a new user on a capable model is asked about their hardware first", async () => {
  const m = serveMock([{ content: "Hi! What machines do you have?" }]);
  try {
    const r = await run([], { OPENAI_BASE_URL: m.url, OPENAI_MODEL: "big-70b" }, "1\n/quit\n");
    assertEquals(r.code, 0, r.out + r.err);
    assert(!r.out.includes("What would you like to do?"), r.out);
    const sys = m.seen.find((b) => b.tools)?.messages[0].content ?? "";
    assertStringIncludes(sys, "learn what hardware they have");
    assertStringIncludes(sys, "recipe");
  } finally {
    await m.close();
  }
});

Deno.test("the model records the fleet as JSON and sees it in the next prompt", async () => {
  const fleet = {
    hosts: { "spark-1": { models: [{ name: "glm53", openai_url: "http://10.0.0.21:8000/v1" }] } },
  };
  const m = serveMock([
    { calls: [{ name: "memory_write", args: { name: "fleet.json", content: "{hosts: oops}" } }] },
    {
      calls: [{
        name: "memory_write",
        args: { name: "fleet.json", content: JSON.stringify(fleet) },
      }],
    },
    { content: "Recorded spark-1." },
    { content: "still here" },
  ]);
  try {
    const r = await run(
      [],
      { OPENAI_BASE_URL: m.url, OPENAI_MODEL: "big-70b" },
      "1\nwhat do I have?\n/quit\n",
    );
    assertEquals(r.code, 0, r.out + r.err);
    const reqs = m.seen.filter((b) => b.tools);
    const tools = reqs.at(-1).messages.filter((x: any) => x.role === "tool");
    assertStringIncludes(tools[0].content, "not valid JSON");
    assertStringIncludes(tools[1].content, "wrote fleet.json");
    assertStringIncludes(
      reqs.at(-1).messages[0].content,
      '"openai_url": "http://10.0.0.21:8000/v1"',
    );
  } finally {
    await m.close();
  }
});
