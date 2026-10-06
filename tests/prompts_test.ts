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
  docs: ["vllm", "ray"],
  memories: ["local-setup"],
  memory_sync: null,
  other_sources: "",
  index: "# Memory index",
  fleet: "",
  plan: "(none yet)",
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
  assertStringIncludes(sys, "exactly one job right now");
  assertStringIncludes(sys, "docs/intermediate-linux");
  assertStringIncludes(sys, "Ubuntu 24.04.5 LTS on x86_64");
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
  const base = flat(systemPrompt(t, new Router(ep("qwen3-4b")), { ...vars, fresh: true }));
  assertStringIncludes(base, "ask these after the user agrees to set up a smarter model");
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
  const base = systemPrompt(t, new Router(ep("qwen3-4b")), { ...vars, fleet });
  assertStringIncludes(base, fleet);
});
