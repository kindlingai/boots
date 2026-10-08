// Offline use, when ai-bootstrap was started with a hosted model or a server
// of the user's (keys, OPENAI_BASE_URL): asked once whether to also set up
// AI on this machine. Yes installs the small base model now (llama.cpp and a
// small Qwen, kept for when nothing else answers) and has the model in use
// set up a full local model; no leaves this machine without one. The answer
// is kept; /setup asks again.

import { join } from "@std/path";
import { installedServer, installLlama, startLlama } from "./llama.ts";
import { scriptPath } from "./intelligence.ts";
import { dataDir, ensureDir, exists } from "./platform.ts";
import { bold, confirm, dim, say, warn } from "./ui.ts";

export interface SetupChoice {
  /** The user wants AI on this machine for offline use. */
  offline: boolean;
  decidedAt: string;
}

export function setupPath(): string {
  return join(dataDir(), "setup.json");
}

export async function loadSetup(): Promise<SetupChoice | null> {
  try {
    const j = JSON.parse(await Deno.readTextFile(setupPath()));
    return typeof j?.offline === "boolean" ? j : null;
  } catch {
    return null;
  }
}

export async function saveSetup(offline: boolean): Promise<void> {
  await ensureDir(dataDir());
  const c: SetupChoice = { offline, decidedAt: new Date().toISOString() };
  await Deno.writeTextFile(setupPath(), JSON.stringify(c, null, 2) + "\n");
}

/** What the offline setup needs from outside (the tests stand in for these). */
export interface SetupDeps {
  ask: (prompt: string, def: boolean) => Promise<boolean>;
  /** Installs llama.cpp and fetches the base model (started once, then stopped). */
  installBase: () => Promise<void>;
  baseInstalled: () => Promise<boolean>;
  fullScript: () => Promise<boolean>;
}

const defaultDeps: SetupDeps = {
  ask: confirm,
  installBase: async () => {
    const run = await startLlama(await installLlama());
    run.stop();
    await run.exited;
  },
  baseInstalled: async () => !!(await installedServer()),
  fullScript: () => exists(scriptPath("full")),
};

/**
 * Asks (once, or again with `force`) whether to set up AI on this machine
 * for offline use, and does the base part. Returns a note for the model in
 * use when there is a full local model to set up, else null.
 */
export async function offerOffline(
  using: string,
  force = false,
  d: SetupDeps = defaultDeps,
): Promise<string | null> {
  const before = await loadSetup();
  if (before && !force) return null;
  const [base, full] = await Promise.all([d.baseInstalled(), d.fullScript()]);
  if (force) {
    say(
      `offline AI on this machine: ${
        before ? (before.offline ? "wanted" : "not wanted") : "not decided"
      }; small base model ${base ? "installed" : "not installed"}; full local model ${
        full ? "set up (start-full script)" : "not set up"
      }`,
    );
  }
  const yes = await d.ask(
    `${
      bold("Also set up AI on this machine, for offline use?")
    } A small local model now (~2.5 GB), then ${using} picks and sets up a full model for this machine's GPU. ${
      dim("(/setup changes this later)")
    }`,
    before?.offline ?? false,
  );
  await saveSetup(yes);
  if (!yes) {
    say(dim("  this machine stays without a local model; /setup to set one up later"));
    return null;
  }
  if (!base) {
    say("setting up the small base model (llama.cpp and a small Qwen)...");
    try {
      await d.installBase();
      say(dim("  the small base model is ready for when nothing else answers"));
    } catch (e) {
      warn(`could not set up the small base model: ${(e as Error).message}`);
    }
  }
  if (full) {
    say(dim("  the full local model is already set up (start-full script)"));
    return null;
  }
  return `(Setup: the user wants AI on this machine for offline use, and the small base model is installed for that. Now set up a full model on this machine: call list_models, tell the user in a sentence which model fits and how big the download is, then set_up_model with it. When it is up, ai-bootstrap switches to it: tell the user, and ask whether to keep using it or go back to ${using} (use_model, which is saved). Then carry on with what the user asks.)`;
}
