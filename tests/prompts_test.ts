import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { type Endpoint, Router } from "../src/llm.ts";
import { loadTemplates, type PromptVars, render, systemPrompt, tierOf } from "../src/prompts.ts";

const ep = (model: string): Endpoint => ({
  label: model,
  baseUrl: "http://x/v1",
  model,
  contextChars: 40000,
});

const OPENING =
  "I'm running on my base intelligence layer right now, which is limited, and I need to get a more intelligent model up and running. Is it OK if I check your system and start that process?";

/** Prompts are Markdown that deno fmt re-wraps; compare text, not line breaks. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const vars: PromptVars = {
  location: "local",
  os_name: "Ubuntu 24.04.5 LTS",
  arch: "x86_64",
  os: "linux",
  host: "me@box",
  shell: "/bin/bash",
  models: "/home/u/.local/share/ai-bootstrap/models",
  scripts: "/home/u/.local/share/ai-bootstrap/intelligence",
  free_port: 41234,
  hardware:
    "AMD Ryzen 9 7950X, 32 CPU threads; 64 GB RAM; NVIDIA GPU: NVIDIA RTX 4090 with 24564 MiB",
  docs: ["vllm", "ray"],
  memories: ["local-setup"],
  memory_sync: null,
  other_sources: "",
  index: "# Memory index",
  fleet: "",
  fresh: false,
};

Deno.test("small models are the base tier", () => {
  for (
    const m of [
      "qwen3-4b",
      "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M",
      "qwen3:8b",
      "llama-3.2-3b",
    ]
  ) {
    assertEquals(tierOf(ep(m)), "base", m);
  }
  for (const m of ["mock-30b", "gpt-oss-120b", "gpt-4.1-mini", "openrouter/auto", "default"]) {
    assertEquals(tierOf(ep(m)), "full", m);
  }
});

Deno.test("models reached with an API key are full tier unless AIBOOT_TIER=base", () => {
  const keyed = { ...ep("qwen/qwen3-8b:free"), keyEnv: "OPENROUTER_API_KEY" };
  const typed = { ...ep("qwen3-4b"), keyInMemory: true };
  assertEquals(tierOf(keyed), "full");
  assertEquals(tierOf(typed), "full");
  Deno.env.set("AIBOOT_TIER", "base");
  try {
    assertEquals(tierOf(keyed), "base");
  } finally {
    Deno.env.delete("AIBOOT_TIER");
  }
});

Deno.test("base prompt focuses on a smarter model and opens with the question", async () => {
  const t = await loadTemplates();
  const sys = systemPrompt(t, new Router(ep("qwen3-4b")), vars);
  assertStringIncludes(flat(sys), OPENING);
  assertStringIncludes(sys, "exactly one job");
  assertStringIncludes(sys, "Ubuntu 24.04.5 LTS on x86_64");
  // It has no memory tools, so no memory context either.
  assert(!sys.includes("Memory INDEX"));
  assert(!sys.includes("{{"), "unfilled placeholder");
});

Deno.test("a capable model gets the main prompt; fallback is announced", async () => {
  const t = await loadTemplates();
  const r = new Router(ep("qwen3-4b"));
  r.setSmart(ep("gpt-oss-120b"));
  const main = systemPrompt(t, r, { ...vars, os: "darwin", shell: "powershell" });
  assertStringIncludes(main, "You are gpt-oss-120b");
  assertStringIncludes(main, "docs/intermediate-macos");
  assertStringIncludes(main, "PowerShell");
  assert(!main.includes("base intelligence layer"));
  // Smart model down: the base model stands in, without re-asking its opening question.
  (r as any).smartDownUntil = Date.now() + 60_000;
  const fb = systemPrompt(t, r, vars);
  assertStringIncludes(fb, "gpt-oss-120b is not answering");
  assertStringIncludes(fb, "Skip any opening question");
});

Deno.test("unknown placeholders are errors", () => {
  assertThrows(() => render("{{nope}}", {}), Error, "nope");
  assertEquals(render("a {{x}} b", { x: "1" }), "a 1 b");
});

Deno.test("empty memory adds onboarding; the full prompt offers recipes", async () => {
  const t = await loadTemplates();
  const full = new Router(ep("gpt-oss-120b"));
  const known = flat(systemPrompt(t, full, vars));
  assertStringIncludes(known, 'point you at a "recipe"');
  assert(!known.includes("learn what hardware they have"));
  const fresh = flat(systemPrompt(t, full, { ...vars, fresh: true }));
  assertStringIncludes(fresh, "learn what hardware they have");
  assertStringIncludes(fresh, "a few DGX Sparks");
  assertStringIncludes(fresh, "Open the session with a one-line greeting");
  // The base model only sets up a model; onboarding waits for the full one.
  const base = flat(systemPrompt(t, new Router(ep("qwen3-4b")), { ...vars, fresh: true }));
  assert(!base.includes("learn what hardware they have"));
  assert(!base.includes('"recipe"'));
  assert(!base.includes("{{") && !fresh.includes("{{"));
});

Deno.test("fleet.json is shown in the prompt; the full prompt explains its shape", async () => {
  const t = await loadTemplates();
  const fleet = JSON.stringify({ hosts: { "spark-1": { models: [{ name: "glm53" }] } } }, null, 2);
  const full = systemPrompt(t, new Router(ep("gpt-oss-120b")), { ...vars, fleet });
  assertStringIncludes(full, "Fleet inventory (memory fleet.json):\n\n```json\n" + fleet + "\n```");
  assertStringIncludes(flat(full), "There is no schema. We recommend this shape");
  assertStringIncludes(full, '"openai_url": "http://10.0.0.21:8000/v1"');
  const empty = systemPrompt(t, new Router(ep("gpt-oss-120b")), vars);
  assertStringIncludes(empty, "{} (empty: nothing recorded yet)");
  // Fields stay on their own lines (the templates are not reflowed).
  assertStringIncludes(
    full,
    "- Location: local\n- Operating system here: Ubuntu 24.04.5 LTS on x86_64\n",
  );
  // The base model has no memory tools, so it is not shown the fleet.
  const base = systemPrompt(t, new Router(ep("qwen3-4b")), { ...vars, fleet });
  assert(!base.includes("glm53"));
});

Deno.test("a failed full model start: the full prompt diagnoses, the base one reports", async () => {
  const t = await loadTemplates();
  const failure = {
    script: "/d/intelligence/start-full.sh",
    log: "/d/intelligence/full.log",
    reason: "start-full exited with status 1 before http://127.0.0.1:8000/v1 answered",
    tail: ["loading weights", "CUDA error: out of memory", "exiting"],
    errors: ["CUDA error: out of memory"],
  };
  // A capable bootstrap (an API model) gets diagnose.md and the full tools.
  const full = systemPrompt(t, new Router(ep("gpt-oss-120b")), { ...vars, failure });
  assertStringIncludes(full, "The full model failed to start");
  assertStringIncludes(full, "start-full exited with status 1");
  assertStringIncludes(full, "loading weights\nCUDA error: out of memory\nexiting");
  assertStringIncludes(full, "start_full_model");
  assert(!full.includes("{{"), "unfilled placeholder");
  // The base model reports it and offers what its tools can do, without the opening question.
  const base = systemPrompt(t, new Router(ep("qwen3-4b")), { ...vars, failure });
  assertStringIncludes(base, "The full model failed to start this time");
  assertStringIncludes(base, "CUDA error: out of memory");
  assertStringIncludes(flat(base), "Skip the opening question");
  assertStringIncludes(base, "Your only tools are");
  assert(!base.includes("{{"), "unfilled placeholder");
});

Deno.test("the base prompt is on rails: setup tools only", async () => {
  const t = await loadTemplates();
  const sys = flat(systemPrompt(t, new Router(ep("qwen3-4b")), vars));
  assertStringIncludes(sys, "Call list_models");
  assertStringIncludes(sys, "Call set_up_model with the recommended model");
  assertStringIncludes(
    sys,
    "Your only tools are reply, list_models, set_up_model, start_full_model, read_log and",
  );
  assertStringIncludes(sys, "You are served at http://x/v1");
  assertStringIncludes(sys, "NVIDIA RTX 4090");
  assert(!sys.includes("{{"), "unfilled placeholder");
});

Deno.test("hardware summaries", async () => {
  const { summarizeMac, summarizeLinux } = await import("../src/hardware.ts");
  assertEquals(
    summarizeMac(
      "Apple M3 Pro",
      36 * 2 ** 30,
      "12",
      "Graphics/Displays:\n    Apple M3 Pro:\n      Chipset Model: Apple M3 Pro\n      Total Number of Cores: 18\n",
      0,
    ),
    "Apple M3 Pro, 12 CPU cores; 36 GB unified memory (the GPU can use about 27 GB by default); GPU: Apple M3 Pro (18 cores, Metal)",
  );
  assertEquals(
    summarizeLinux(
      "Model name:  AMD EPYC 9654\nCPU(s):  192\n",
      "MemTotal:  792723456 kB\n",
      "NVIDIA H100 80GB HBM3, 81559 MiB\n",
      "",
    ),
    "AMD EPYC 9654, 192 CPU threads; 756 GB RAM; NVIDIA GPU: NVIDIA H100 80GB HBM3 with 81559 MiB",
  );
});

Deno.test("goals.json is in the full prompt, with its shape", async () => {
  const t = await loadTemplates();
  const goals = JSON.stringify([{ title: "Serve GLM on the Sparks", done: false }], null, 2);
  const full = systemPrompt(t, new Router(ep("gpt-oss-120b")), { ...vars, goals });
  assertStringIncludes(full, "Goals (memory goals.json):\n\n```json\n" + goals + "\n```");
  assertStringIncludes(
    flat(full),
    'a list of goals, each `{"title": "...", "details": "...", "done": false, "active": true, "children": [ ...goals... ]}`',
  );
  const empty = systemPrompt(t, new Router(ep("gpt-oss-120b")), { ...vars, goals: "[]\n" });
  assertStringIncludes(empty, "[] (empty: no goals recorded yet)");
  assert(!full.includes("{{"), "unfilled placeholder");
});

Deno.test("with nothing set up, the prompt points the full model at the Docker guide", async () => {
  const t = await loadTemplates();
  const full = new Router(ep("mock-30b"));
  const empty = systemPrompt(t, full, vars);
  assertStringIncludes(empty, "## Nothing is set up yet");
  assertStringIncludes(empty, "memory_read docs/docker");
  assertStringIncludes(systemPrompt(t, full, { ...vars, fleet: "{ }" }), "Nothing is set up yet");
  const known = systemPrompt(t, full, { ...vars, fleet: '{"hosts": {"box": {}}}' });
  assert(!known.includes("Nothing is set up yet"), "not once something is recorded");
  const base = systemPrompt(t, new Router(ep("qwen3-4b")), vars);
  assert(!base.includes("Nothing is set up yet"), "the base model is on rails");
});
