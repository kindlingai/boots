// System prompts, built from the templates in docs/prompts/ (see its
// README). base.md drives a small base model; main.md a capable one.

import { type Update, updateNote } from "./update.ts";
import { join } from "@std/path";
import type { Endpoint, Router } from "./llm.ts";
import { sizeFromName } from "./discover.ts";
import { docsDir, languageRule } from "./platform.ts";
import { CAUSE_HINT, type FullFailure } from "./intelligence.ts";

export type Tier = "base" | "full";

/**
 * Small models (8B or fewer by name) are the base intelligence layer. A
 * model reached with an API key is full tier: the user chose it. Only an
 * explicit AIBOOT_TIER overrides either rule.
 */
export function tierOf(ep: Endpoint): Tier {
  const forced = Deno.env.get("AIBOOT_TIER");
  if (forced === "base" || forced === "full") return forced;
  if (ep.tier) return ep.tier;
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
  diagnose: string;
}

export async function loadTemplates(dir = join(docsDir(), "prompts")): Promise<Templates> {
  const read = (n: string) => Deno.readTextFile(join(dir, `${n}.md`));
  const [base, main, context, onboarding, diagnose] = await Promise.all(
    ["base", "main", "context", "onboarding", "diagnose"].map(read),
  );
  return { base, main, context, onboarding, diagnose };
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
  models: string;
  scripts: string;
  free_port: number;
  /** This machine's scratch directory ($BOOTS_SCRATCH). */
  scratch?: string;
  hardware: string;
  docs: string[];
  memories: string[];
  /** The playbooks (run_playbook), with what each does. */
  playbooks?: { name: string; about: string }[];
  memory_sync: string | null;
  other_sources: string;
  index: string;
  /** memory fleet.json as stored, "" when there is none. */
  fleet: string;
  /** memory goals.json as stored, "" when there is none. */
  goals?: string;
  /** Memory holds nothing about the user yet: onboard them. */
  fresh: boolean;
  /** The full model's start script failed at boot: diagnose that first. */
  failure?: FullFailure | null;
  /** A newer ai-bootstrap release: offer to update. */
  update?: Update | null;
  /** The history was restored from the previous session: when it was last active, and where. */
  restored?: { at: string; location?: string | null } | null;
}

export function systemPrompt(t: Templates, router: Router, v: PromptVars): string {
  // The user's language comes first: small models drift into Chinese otherwise.
  let prompt = `${languageRule()}\n\n${basePrompt(t, router, v)}`;
  if (!fleetRecorded(v.fleet) && tierOf(router.current()) !== "base") {
    prompt += `\n\n${NOTHING_SET_UP}`;
  }
  if (v.restored) prompt += `\n\n${restoredNote(v.restored.at, v.restored.location)}`;
  if (v.update) prompt += `\n\n${updateNote(v.update)}`;
  return prompt;
}

/** fleet.json holds something (not missing, not an empty object). */
function fleetRecorded(fleet: string): boolean {
  const t = fleet.trim();
  return t !== "" && !/^\{\s*\}$/.test(t);
}

/** With nothing recorded yet, steer the first installs towards Docker. */
export const NOTHING_SET_UP = `## Nothing is set up yet

fleet.json is empty: you have not installed anything for this user. Before installing the first
model server or tool, read docs/docker (memory_read docs/docker). Prefer running each service as a
Docker container: it is hermetic (nothing installed into the host), removed with one command, and
traceable (labelled with what made it and why). Put a small MCP server inside each service's
container, as that doc shows, and add it with mcp_add so the service can be managed through tools.
Install directly on the host only where Docker cannot do the job (the Mac GPU) or the user prefers
it.`;

/** The conversation starts with turns restored from the previous session. */
export function restoredNote(at: string, location?: string | null): string {
  const hop = location
    ? `\n\nThe previous session ended while you were connected over ssh (location ${location}). That connection was interrupted when the session was resumed: you are on the local machine now, and run and the other tools act here. To carry on there, connect again with the ssh tool.`
    : "";
  return `## Restored conversation

The first turns of this conversation are the end of the previous session (last active ${
    at.slice(0, 16).replace("T", " ")
  } UTC), restored when ai-bootstrap restarted. Things may have changed since: check before relying
on them. history_search looks further back.${hop}`;
}

function basePrompt(t: Templates, router: Router, v: PromptVars): string {
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
    models: v.models,
    scripts: v.scripts,
    free_port: String(v.free_port),
    scratch: v.scratch ?? "(none)",
    hardware: v.hardware,
    shell_note: v.shell === "powershell" ? "Commands here run in PowerShell.\n" : "",
    docs: v.docs.join(", ") || "none",
    memories: v.memories.join(", ") || "none",
    playbooks: (v.playbooks ?? []).map((b) => (b.about ? `${b.name} (${b.about})` : b.name))
      .join("; ") || "none yet",
    memory_sync: v.memory_sync ?? "not set up",
    other_sources: v.other_sources,
    index: v.index.trim(),
    fleet: v.fleet.trim() || "{} (empty: nothing recorded yet)",
    goals: v.goals?.trim().replace(/^\[\s*\]$/, "") || "[] (empty: no goals recorded yet)",
  });
  const base = tierOf(ep) === "base";
  const block = (l: string[], empty: string) => l.join("\n") || empty;
  // On rails, the base model reports a failed start and offers what its tools can do.
  const failure = v.failure && base
    ? `
## The full model failed to start this time

ai-bootstrap ran ${v.failure.script} and it failed: ${v.failure.reason}.
The last lines of ${v.failure.log}:

\`\`\`text
${block(v.failure.tail, "(the log is empty)")}
\`\`\`

Lines that mention errors:

\`\`\`text
${block(v.failure.errors, "(none)")}
\`\`\`

${
      v.failure.cause
        ? `Likely cause: ${CAUSE_HINT[v.failure.cause]}\n\n`
        : ""
    }Skip the opening question. Open by telling the user, with reply, that the full model did not start
and what the lines above suggest, in plain words (read_log shows more). Then offer what step 4
says for that cause.
`
    : "";
  if (v.failure && !base) {
    const f = v.failure;
    return render(t.diagnose, {
      model: ep.label,
      bootstrap_url: router.bootstrap.baseUrl,
      tier_note: base
        ? "This is the small base model: it is limited, so be careful and check each step."
        : "",
      reason: f.reason,
      script: f.script,
      log: f.log,
      tail: f.tail.join("\n") || "(the log is empty)",
      errors: f.errors.join("\n") || "(none)",
      context,
    }).trim();
  }
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
    bootstrap_url: router.bootstrap.baseUrl,
    bootstrap: router.bootstrap.label,
    smart: router.smart?.label ?? "none",
    fallback_note: fallback,
    os_doc: osDoc,
    failure,
    os_name: v.os_name,
    arch: v.arch,
    hardware: v.hardware,
    context,
  }).trim();
}
