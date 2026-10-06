// System prompts, built from the templates in docs/prompts/ (see its
// README). base.md drives a small base model; main.md a capable one.

import { join } from "@std/path";
import type { Endpoint, Router } from "./llm.ts";
import { sizeFromName } from "./discover.ts";
import { docsDir } from "./platform.ts";

export type Tier = "base" | "full";

/**
 * Small models (8B or fewer by name) are the base intelligence layer. A
 * model reached with an API key is full tier: the user chose it. Only an
 * explicit AIBOOT_TIER overrides either rule.
 */
export function tierOf(ep: Endpoint): Tier {
  const forced = Deno.env.get("AIBOOT_TIER");
  if (forced === "base" || forced === "full") return forced;
  if (ep.keyEnv || ep.keyInMemory) return "full";
  const b = sizeFromName(ep.model);
  return b > 0 && b <= 8 ? "base" : "full";
}

/** The tier of whichever model is answering now. */
export function currentTier(router: Router): Tier {
  return tierOf(router.current());
}

export interface Templates {
  base: string;
  main: string;
  context: string;
  onboarding: string;
}

export async function loadTemplates(dir = join(docsDir(), "prompts")): Promise<Templates> {
  const read = (n: string) => Deno.readTextFile(join(dir, `${n}.md`));
  const [base, main, context, onboarding] = await Promise.all(
    ["base", "main", "context", "onboarding"].map(read),
  );
  return { base, main, context, onboarding };
}

/** Fills {{name}} placeholders. Unknown names are an error, so typos surface in tests. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`unknown prompt placeholder {{${k}}}`);
    return vars[k];
  });
}

export interface PromptVars {
  location: string;
  os_name: string;
  arch: string;
  os: string;
  host: string;
  shell: string;
  docs: string[];
  memories: string[];
  memory_sync: string | null;
  other_sources: string;
  index: string;
  plan: string;
  /** Memory holds nothing about the user yet: onboard them. */
  fresh: boolean;
}

export function systemPrompt(t: Templates, router: Router, v: PromptVars): string {
  const ep = router.current();
  const fallback = router.usingFallback() && router.smart
    ? `\nThe smarter model ${router.smart.label} is not answering right now, so you are standing in for it. Skip any opening question: tell the user, keep to small safe steps, and help get that model answering again.\n`
    : "";
  const osDoc = `docs/intermediate-${
    ({ darwin: "macos", windows: "windows" } as Record<string, string>)[v.os] ?? "linux"
  }`;
  const context = render(t.context, {
    location: v.location,
    os_name: v.os_name,
    arch: v.arch,
    os_doc: osDoc,
    host: v.host,
    shell_note: v.shell === "powershell" ? "Commands here run in PowerShell.\n" : "",
    docs: v.docs.join(", ") || "none",
    memories: v.memories.join(", ") || "none",
    memory_sync: v.memory_sync ?? "not set up",
    other_sources: v.other_sources,
    index: v.index.trim(),
    plan: v.plan,
  });
  const base = tierOf(ep) === "base";
  const onboarding = v.fresh
    ? render(t.onboarding, {
      onboarding_timing: base
        ? "\nYou are on the base model: ask these after the user agrees to set up a smarter model, since the answers decide where it should run. Keep it to a few questions."
        : "\nOpen the session with a one-line greeting, mention recipes, and ask the first of these questions.",
    }).trim()
    : "";
  return render(base ? t.base : t.main, {
    onboarding,
    model: ep.label,
    bootstrap: router.bootstrap.label,
    smart: router.smart?.label ?? "none",
    fallback_note: fallback,
    os_doc: osDoc,
    context,
  }).trim();
}
