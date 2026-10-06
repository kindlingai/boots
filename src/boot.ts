// Boot: find a bootstrap AI. Local servers and API keys are offered to the
// user; with none, ai-bootstrap fetches llama.cpp and a small Qwen and uses that
// without asking.

import type { Endpoint } from "./llm.ts";
import { scanApiKeys, scanLocal, type Source } from "./discover.ts";
import { installedServer, installLlama, type Running, startLlama } from "./llama.ts";
import type { Memory } from "./memory.ts";
import { bold, choose, confirm, dim, info } from "./ui.ts";

export interface Booted {
  bootstrap: Endpoint;
  sources: Source[];
  llama: Running | null;
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

export async function boot(memory: Memory): Promise<Booted> {
  info("looking for local AI sources...");
  const [local, facts] = await Promise.all([scanLocal(), machineFacts()]);
  const sources = [...local, ...(await scanApiKeys())];
  const installed = await installedServer();
  let bootstrap: Endpoint;
  let llama: Running | null = null;

  if (!sources.length) {
    if (!installed) {
      info("no bootstrap intelligence found (no local model servers, no API keys)");
      const ok = await confirm(
        "Download llama.cpp and Qwen3 4B (~2.5 GB) to get started?",
        true,
      );
      if (!ok) {
        throw new Error(
          "nothing to bootstrap with. Set OPENROUTER_API_KEY, OPENAI_API_KEY, or OPENAI_BASE_URL (+ OPENAI_MODEL), or start a local model server",
        );
      }
    } else info("no running AI found; starting the installed llama.cpp");
    llama = await startLlama(installed ?? (await installLlama()));
    bootstrap = llama.endpoint;
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
    }
  }
  console.log(`${bold("bootstrap:")} ${bootstrap.label} ${dim(bootstrap.baseUrl)}`);

  const found = sources.length
    ? sources.map((s) => `  - ${s.label} (${s.endpoint.baseUrl})`).join("\n")
    : "  - none";
  const allFacts =
    `${facts}\n- AI sources found at boot:\n${found}\n- bootstrap this session: ${bootstrap.label} (${bootstrap.baseUrl})${
      llama ? `, started by ${llama.script}` : ""
    }`;
  await memory.recordLocalSetup(allFacts);
  return { bootstrap, sources, llama, facts: allFacts };
}
