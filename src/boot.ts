// Boot: find a bootstrap AI. Local servers and API keys are offered to the
// user; with none, ai-bootstrap fetches llama.cpp and a small Qwen and uses that
// without asking.

import type { Endpoint } from "./llm.ts";
import { scanApiKeys, scanLocal, type Source } from "./discover.ts";
import { installedServer, installLlama, notStarted, type Running, startLlama } from "./llama.ts";
import type { Memory } from "./memory.ts";
import { bold, choose, confirm, dim, info, say, warn } from "./ui.ts";
import { freeBytes } from "./hardware.ts";
import { modelsDir } from "./platform.ts";

export interface Booted {
  bootstrap: Endpoint;
  sources: Source[];
  llama: Running | null;
  /** The installed llama-server for the bootstrap, when it was left unstarted (deferLocal). */
  deferred: string | null;
  /** The bootstrap is a hosted model or the endpoint given (a key, OPENAI_BASE_URL). */
  hosted: boolean;
  facts: string;
}

async function gpus(): Promise<string> {
  try {
    const o = await new Deno.Command("nvidia-smi", {
      args: ["-L"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (o.code === 0) return new TextDecoder().decode(o.stdout).trim();
  } catch {
    // no NVIDIA tools
  }
  if (Deno.build.os === "darwin") {
    return `Apple ${Deno.build.arch === "aarch64" ? "Silicon (Metal)" : "Intel Mac"}`;
  }
  return "none detected (no nvidia-smi)";
}

async function machineFacts(): Promise<string> {
  const mem = (() => {
    try {
      return `${(Deno.systemMemoryInfo().total / 2 ** 30).toFixed(1)} GiB`;
    } catch {
      return "unknown";
    }
  })();
  return [
    `- host: ${Deno.hostname()} (${Deno.build.os} ${Deno.osRelease()}, ${Deno.build.arch})`,
    `- cpus: ${navigator.hardwareConcurrency}`,
    `- memory: ${mem}`,
    `- gpus: ${(await gpus()).replace(/\n/g, "; ")}`,
  ].join("\n");
}

/**
 * `deferLocal`: the full model has a start script, so an installed local
 * bootstrap is not started yet (it only would be handed over at once).
 */
export async function boot(
  memory: Memory,
  deferLocal = false,
  pinned: Endpoint | null = null,
): Promise<Booted> {
  info(pinned ? "using the endpoint given (OPENAI_BASE_URL)" : "looking for local AI sources...");
  const [local, facts] = await Promise.all([pinned ? [] : scanLocal(), machineFacts()]);
  const sources = pinned ? [] : [...local, ...(await scanApiKeys())];
  const installed = pinned ? null : await installedServer();
  let bootstrap: Endpoint;
  let llama: Running | null = null;
  let deferred: string | null = null;
  let hosted = false;

  if (pinned) {
    // Given on the command line: no choosing, nothing downloaded or started.
    bootstrap = pinned;
    hosted = true;
  } else if (!sources.length) {
    if (!installed) {
      info("no bootstrap intelligence found (no local model servers, no API keys)");
      const free = await freeBytes(modelsDir());
      if (free !== null && free < 4 * 2 ** 30) {
        warn(
          `only ${
            (free / 2 ** 30).toFixed(1)
          } GB of disk is free where models go (${modelsDir()}); the download needs about 3 GB, and a smarter model later needs 10-16 GB more`,
        );
      }
      const ok = await confirm(
        "Download llama.cpp and Qwen3 4B (~2.5 GB) to get started?",
        true,
      );
      if (!ok) {
        throw new Error(
          "nothing to bootstrap with. Set OPENROUTER_API_KEY, OPENAI_API_KEY, or OPENAI_BASE_URL (+ OPENAI_MODEL), or start a local model server",
        );
      }
    } else if (deferLocal) {
      info("the full model has a start script: starting it first; the small model waits");
    } else info("no running AI found; starting the installed llama.cpp");
    if (installed && deferLocal) {
      deferred = installed;
      bootstrap = notStarted();
    } else {
      llama = await startLlama(installed ?? (await installLlama()));
      bootstrap = llama.endpoint;
    }
  } else {
    const labels = sources.map((s) => s.label);
    labels.push(
      installed
        ? "local llama.cpp (installed) with a small Qwen"
        : "download llama.cpp and a small Qwen (~2.5 GB)",
    );
    const pick = await choose("Which AI should bootstrap this session?", labels, 0);
    if (pick < 0) throw new Error("no bootstrap AI chosen");
    if (pick === sources.length) {
      llama = await startLlama(installed ?? (await installLlama()));
      bootstrap = llama.endpoint;
    } else {
      bootstrap = sources[pick].endpoint;
      hosted = sources[pick].kind === "api";
    }
  }
  if (!deferred) say(`${bold("bootstrap:")} ${bootstrap.label} ${dim(bootstrap.baseUrl)}`);

  const found = pinned
    ? `  - ${pinned.model} at ${pinned.baseUrl} (OPENAI_BASE_URL: used for everything)`
    : sources.length
    ? sources.map((s) => `  - ${s.label} (${s.endpoint.baseUrl})`).join("\n")
    : "  - none";
  const allFacts =
    `${facts}\n- AI sources found at boot:\n${found}\n- bootstrap this session: ${bootstrap.label}${
      deferred ? " (started only if the full model is not up)" : ` (${bootstrap.baseUrl})`
    }${llama ? `, started by ${llama.script}` : ""}`;
  await memory.recordLocalSetup(allFacts);
  return { bootstrap, sources, llama, deferred, hosted, facts: allFacts };
}
