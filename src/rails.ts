// The base model's rails: a short catalog of Qwen models (8-16 GB downloads),
// sized against what the GPU reports, and one step that sets the chosen one
// up as the full model: the GPU build of llama.cpp (Metal on macOS, Vulkan
// elsewhere), start-full.sh, the download, the start and the switch.

import { join } from "@std/path";
import { DEFAULT_MODEL, installLlama } from "./llama.ts";
import { freeBytes } from "./hardware.ts";
import {
  describeFailure,
  dirSize,
  type FullFailure,
  gpuOffload as offload,
  logPath,
  scriptPath,
  startFull,
} from "./intelligence.ts";
import type { Endpoint } from "./llm.ts";
import type { Memory } from "./memory.ts";
import { isWindows, modelsDir, randomFreePort } from "./platform.ts";

export interface CatalogModel {
  id: string;
  label: string;
  /** llama-server -hf argument: <repo>:<quant>. */
  hf: string;
  /** Approximate download size. */
  fileGB: number;
  /** KV cache per 1000 tokens of context, f16. */
  kvMBPer1k: number;
  note: string;
  /** Hybrid thinking model: start it with thinking off (much faster replies). */
  thinks?: boolean;
}

/**
 * Best first. The 30B-A3B mixture of experts leads everywhere: it runs ~3B
 * parameters per token (fast even where memory bandwidth is the limit, as on
 * Apple silicon) and does not think before answering. Dense models are only
 * for machines without the memory for it. Sizes are approximate.
 */
export const CATALOG: CatalogModel[] = [
  {
    id: "qwen3-30b-a3b",
    label: "Qwen3 30B-A3B Instruct 2507 (UD-Q3_K_XL)",
    hf: "unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:UD-Q3_K_XL",
    fileGB: 13.8,
    kvMBPer1k: 96,
    note: "mixture of experts: fast, good with tools; the one to use",
  },
  {
    id: "qwen3-30b-a3b-q2",
    label: "Qwen3 30B-A3B Instruct 2507 (UD-Q2_K_XL)",
    hf: "unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:UD-Q2_K_XL",
    fileGB: 11.8,
    kvMBPer1k: 96,
    note: "the same model, smaller, for less memory",
  },
  {
    id: "qwen3-14b-q4",
    label: "Qwen3 14B (Q4_K_M)",
    hf: "unsloth/Qwen3-14B-GGUF:Q4_K_M",
    fileGB: 9.0,
    kvMBPer1k: 160,
    note: "dense and slower; only when the 30B-A3B does not fit",
    thinks: true,
  },
  {
    id: "qwen3-8b",
    label: "Qwen3 8B (Q8_0)",
    hf: "unsloth/Qwen3-8B-GGUF:Q8_0",
    fileGB: 8.7,
    kvMBPer1k: 144,
    note: "the smallest; for GPUs with about 12 GB",
    thinks: true,
  },
];

/** No longer offered, but recognised in the models folder so their downloads can be removed. */
const RETIRED: Pick<CatalogModel, "id" | "hf">[] = [
  { id: "qwen3-14b", hf: "unsloth/Qwen3-14B-GGUF:Q6_K" },
];

const CONTEXTS = [32768, 16384];
const OVERHEAD_GB = 1.5;

export function needsGB(m: CatalogModel, ctx: number): number {
  return m.fileGB + (m.kvMBPer1k * ctx) / 1000 / 1024 + OVERHEAD_GB;
}

export interface Device {
  name: string;
  description: string;
  totalMB: number;
  freeMB: number;
}

/** Devices from `llama-server --list-devices`. */
export function parseDevices(text: string): Device[] {
  const out: Device[] = [];
  for (const m of text.matchAll(/^\s*([\w.-]+): (.+?) \((\d+) MiB, (\d+) MiB free\)/gm)) {
    if (/^CPU/i.test(m[1])) continue;
    out.push({ name: m[1], description: m[2].trim(), totalMB: +m[3], freeMB: +m[4] });
  }
  return out;
}

export interface Fit {
  model: CatalogModel;
  ctx: number;
  needs: number;
  /** Fits the GPU (or RAM) budget. */
  fits: boolean;
  /** Disk still needed for its download, and whether there is that much free. */
  diskNeedGB?: number;
  diskOK?: boolean;
}

/** Something in the models folder: a file, or a Hugging Face cache folder (models--org--repo). */
export interface Download {
  path: string;
  bytes: number;
  partial: boolean;
  /** Catalog ids it belongs to; "bootstrap" for the base model's. */
  models: string[];
}

const PARTIAL = /\.(downloadInProgress|incomplete|part|tmp)$/i;
const GB = 2 ** 30;
/** Room to leave on the disk beyond the download. */
const DISK_MARGIN_GB = 2;

const repoOf = (hf: string) => hf.split(":")[0].split("/").pop()!.toLowerCase();
const quantOf = (hf: string) => (hf.split(":")[1] ?? "").toLowerCase();

/** Which catalog models (or the bootstrap) a download belongs to. */
export function ownersOf(path: string, isRepoDir: boolean, bootstrapHf: string): string[] {
  const p = path.toLowerCase();
  if (p.includes(repoOf(bootstrapHf))) return ["bootstrap"];
  return [...CATALOG, ...RETIRED].filter((m) =>
    p.includes(repoOf(m.hf)) && (isRepoDir || p.includes(quantOf(m.hf)))
  ).map((m) => m.id);
}

/** What is in the models folder, as units that can be removed whole. */
export async function downloads(
  dir = join(modelsDir(), "llama.cpp"),
  bootstrapHf = Deno.env.get("AIBOOT_BOOTSTRAP_MODEL") ?? DEFAULT_MODEL,
): Promise<Download[]> {
  const out: Download[] = [];
  const walk = async (d: string) => {
    let entries: Deno.DirEntry[] = [];
    try {
      entries = await Array.fromAsync(Deno.readDir(d));
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory && e.name.startsWith("models--")) {
        const files: string[] = [];
        const list = async (x: string) => {
          for await (const f of Deno.readDir(x)) {
            if (f.isDirectory) await list(join(x, f.name));
            else files.push(f.name);
          }
        };
        await list(p).catch(() => {});
        out.push({
          path: p,
          bytes: await dirSize(p),
          partial: files.some((f) => PARTIAL.test(f)),
          models: ownersOf(e.name, true, bootstrapHf),
        });
      } else if (e.isDirectory) await walk(p);
      else if (e.isFile) {
        const bytes = (await Deno.stat(p).catch(() => ({ size: 0 }))).size;
        out.push({
          path: p,
          bytes,
          partial: PARTIAL.test(e.name),
          models: ownersOf(e.name, false, bootstrapHf),
        });
      }
    }
  };
  await walk(dir);
  return out;
}

/** Downloads that can go: unfinished ones and catalog models other than `keep`; never the bootstrap's. */
export function removable(all: Download[], keep?: string): Download[] {
  return all.filter((d) => {
    if (d.models.includes("bootstrap")) return false;
    // The one being set up stays, even unfinished: its download resumes.
    if (keep && d.models.includes(keep)) return false;
    return d.partial || d.models.length > 0;
  });
}

/** Removes the downloads `removable` picks; returns what went. */
export async function removeDownloads(keep?: string): Promise<Download[]> {
  const gone = removable(await downloads(), keep);
  for (const d of gone) await Deno.remove(d.path, { recursive: true }).catch(() => {});
  return gone;
}

function sizeGB(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

/** Marks each fit with the disk its download still needs. */
export function withDisk(fits: Fit[], all: Download[], freeGB: number | null): Fit[] {
  return fits.map((f) => {
    const have = all.filter((d) => d.models.includes(f.model.id)).reduce((n, d) => n + d.bytes, 0) /
      GB;
    const diskNeedGB = Math.max(0, f.model.fileGB - have) + DISK_MARGIN_GB;
    return { ...f, diskNeedGB, diskOK: freeGB === null || diskNeedGB <= freeGB };
  });
}

export interface Plan {
  server: string;
  devices: Device[];
  /** What the model can use, in GB. */
  budgetGB: number;
  accel: string;
  /** Why there is no GPU acceleration, when there is none. */
  warning: string | null;
  fits: Fit[];
  /** Free disk where models go, in GB (null: unknown). */
  diskFreeGB: number | null;
  downloads: Download[];
}

/** For each model, the largest context that fits the budget, if any does. */
export function fitAll(budgetGB: number): Fit[] {
  return CATALOG.map((model) => {
    for (const ctx of CONTEXTS) {
      const needs = needsGB(model, ctx);
      if (needs <= budgetGB) return { model, ctx, needs, fits: true };
    }
    const ctx = CONTEXTS.at(-1)!;
    return { model, ctx, needs: needsGB(model, ctx), fits: false };
  });
}

async function listDevices(server: string): Promise<Device[]> {
  try {
    const env: Record<string, string> = {};
    if (Deno.build.os === "linux") env.LD_LIBRARY_PATH = join(server, "..");
    const o = await new Deno.Command(server, {
      args: ["--list-devices"],
      env,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(60_000),
    }).output();
    const d = new TextDecoder();
    return parseDevices(d.decode(o.stdout) + "\n" + d.decode(o.stderr));
  } catch {
    return [];
  }
}

/** Installs the GPU build of llama.cpp if needed and sizes the catalog against its devices. */
/**
 * `holding`: the catalog model ai-bootstrap is running as the full model now;
 * setting up another stops it first, so its memory counts as free.
 */
export async function plan(hardware: string, holding?: string): Promise<Plan> {
  const server = await installLlama("gpu");
  const devices = await listDevices(server);
  let budgetGB: number;
  let accel: string;
  let warning: string | null = null;
  if (devices.length) {
    budgetGB = devices.reduce((n, d) => n + d.freeMB, 0) / 1024;
    accel = devices.map((d) => `${d.name} ${d.description}`).join(", ");
  } else {
    const mem = Deno.systemMemoryInfo();
    budgetGB = (mem.available * 0.8) / 2 ** 30;
    accel = "CPU only";
    const gpu = /GPU/.test(hardware) && !/no GPU found/.test(hardware);
    warning = gpu
      ? `This machine has a GPU, but llama.cpp cannot use it${
        Deno.build.os === "linux"
          ? ": install the Vulkan loader and driver (Ubuntu/Debian: sudo apt install libvulkan1 mesa-vulkan-drivers; NVIDIA's driver brings its own), then try again"
          : ": update the GPU driver, then try again"
      }. Without it the model runs on the CPU, slowly.`
      : "No GPU that llama.cpp can use was found, so the model would run on the CPU, slowly.";
  }
  const held = CATALOG.find((m) => m.id === holding);
  if (held) {
    const gb = needsGB(held, CONTEXTS.at(-1)!);
    budgetGB += gb;
    accel += ` (counting ~${gb.toFixed(1)} GB held by the running ${held.id}, freed for a switch)`;
  }
  const free = await freeBytes(modelsDir());
  const diskFreeGB = free === null ? null : free / GB;
  const all = await downloads();
  return {
    server,
    devices,
    budgetGB,
    accel,
    warning,
    fits: withDisk(fitAll(budgetGB), all, diskFreeGB),
    diskFreeGB,
    downloads: all,
  };
}

export function describePlan(p: Plan): string {
  const owner = (d: Download) => d.models.length ? d.models.join("/") : "other";
  const lines = [
    `Accelerator: ${p.accel}; about ${p.budgetGB.toFixed(1)} GB free for the model.`,
    ...(p.warning ? [`Warning: ${p.warning}`] : []),
    `Disk: ${
      p.diskFreeGB === null ? "unknown" : `${p.diskFreeGB.toFixed(1)} GB`
    } free for downloads.${
      p.downloads.length
        ? ` Already in the models folder: ${
          p.downloads.map((d) =>
            `${owner(d)} ${sizeGB(d.bytes)}${d.partial ? " (unfinished)" : ""}`
          )
            .join(", ")
        }.`
        : ""
    }`,
    "Models, best first:",
    ...p.fits.map((f) =>
      `- ${f.model.id}: ${f.model.label}, ~${f.model.fileGB} GB download, needs ~${
        f.needs.toFixed(1)
      } GB with ${f.ctx / 1024}k context: ${f.fits ? "FITS" : "does not fit"}${
        f.fits && f.diskOK === false
          ? `, but needs ${f.diskNeedGB!.toFixed(1)} GB of free disk (NOT ENOUGH DISK)`
          : ""
      }. ${f.model.note}`
    ),
  ];
  // Memory decides the model; a short disk is fixed by freeing space, not by a smaller model.
  const best = p.fits.find((f) => f.fits);
  if (!best) {
    lines.push(
      "None fits. Suggest a hosted model instead: restart ai-bootstrap with OPENROUTER_API_KEY or OPENAI_API_KEY set.",
    );
  } else if (best.diskOK === false) {
    const freeable = removable(p.downloads, best.model.id).reduce((n, d) => n + d.bytes, 0);
    lines.push(
      `Recommended: ${best.model.id}, but the disk is too full: it needs ${
        best.diskNeedGB!.toFixed(1)
      } GB free and there is ${p.diskFreeGB?.toFixed(1)} GB. Warn the user.${
        freeable
          ? ` remove_downloads (keep ${best.model.id}) can free ${
            sizeGB(freeable)
          } of unfinished or unused model downloads.`
          : ""
      } Otherwise the user must free disk space. Do not set up a smaller model because of disk: free space, then set up ${best.model.id}.`,
    );
  } else lines.push(`Recommended: ${best.model.id}.`);
  return lines.join("\n");
}

const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function fullScript(
  m: CatalogModel,
  server: string,
  port: number,
  ctx: number,
  accel: string,
  windows = isWindows,
): string {
  const cache = join(modelsDir(), "llama.cpp");
  // Qwen3 hybrids think at length before every answer, invisibly: too slow for an agent.
  const args = `-hf ${m.hf} --alias ${m.id} --host 127.0.0.1 --port ${port} --jinja -c ${ctx}${
    m.thinks ? " --reasoning off" : ""
  }`;
  const head = `Starts the full model: ${m.label} on llama.cpp (${accel}).`;
  if (windows) {
    return [
      "@echo off",
      `rem ${head}`,
      "rem Written by ai-bootstrap (set_up_model).",
      `rem endpoint: http://127.0.0.1:${port}/v1 ${m.id}`,
      `set "LLAMA_CACHE=${cache}"`,
      `"${server}" ${args}`,
      "",
    ].join("\r\n");
  }
  const lib = Deno.build.os === "linux"
    ? `export LD_LIBRARY_PATH=${sq(join(server, ".."))}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\n`
    : "";
  return `#!/bin/sh
# ${head}
# Written by ai-bootstrap (set_up_model).
# endpoint: http://127.0.0.1:${port}/v1 ${m.id}
export LLAMA_CACHE=${sq(cache)}
${lib}exec ${sq(server)} ${args}
`;
}

/** Notes the model in fleet.json and in a full-model memory, with a line in INDEX. */
async function record(
  memory: Memory,
  m: CatalogModel,
  ep: Endpoint,
  script: string,
  accel: string,
) {
  let fleet: any = {};
  try {
    fleet = JSON.parse((await memory.fleet()) || "{}");
  } catch {
    fleet = {};
  }
  if (typeof fleet !== "object" || !fleet || Array.isArray(fleet)) fleet = {};
  fleet.hosts ??= {};
  const host = Deno.hostname();
  fleet.hosts[host] ??= {};
  const models = Array.isArray(fleet.hosts[host].models) ? fleet.hosts[host].models : [];
  fleet.hosts[host].models = [
    ...models.filter((x: any) => x?.name !== m.id),
    {
      name: m.id,
      hf: m.hf,
      server: "llama.cpp",
      accel,
      openai_url: ep.baseUrl,
      start_script: script,
      role: "full model",
    },
  ];
  await memory.write("fleet.json", JSON.stringify(fleet, null, 2));
  await memory.write(
    "full-model",
    `# Full model (this machine: ${host})\n\n` +
      `- ${m.label}, from ${m.hf}, served by llama.cpp on ${accel}\n` +
      `- OpenAI-compatible endpoint: ${ep.baseUrl} (model ${m.id})\n` +
      `- Started by ${script}; ai-bootstrap runs it at startup and stops it on exit.\n` +
      `- Weights are in ${join(modelsDir(), "llama.cpp")}.\n`,
  );
  const index = await memory.index();
  if (!/\bfull-model\b/.test(index)) {
    await memory.write(
      "INDEX",
      `${index.trimEnd()}\n- full-model: the local full model and how it starts\n`,
    );
  }
}

/** Sets a catalog model up as the full model and starts it. Returns the endpoint, or why not. */
export async function setUpModel(
  id: string,
  hardware: string,
  memory: Memory,
  signal?: AbortSignal,
  holding?: string,
): Promise<{ ep: Endpoint; summary: string } | { error: string; failure?: FullFailure }> {
  const p = await plan(hardware, holding);
  const fit = p.fits.find((f) => f.model.id === id);
  if (!fit) return { error: `no model ${id} in the catalog.\n${describePlan(p)}` };
  if (!fit.fits) return { error: `${id} does not fit here.\n${describePlan(p)}` };
  if (fit.diskOK === false) {
    return {
      error: `not enough disk for ${id}: it needs ${fit.diskNeedGB!.toFixed(1)} GB free.\n${
        describePlan(p)
      }`,
    };
  }
  const m = fit.model;
  const port = randomFreePort();
  const script = scriptPath("full");
  await Deno.writeTextFile(script, fullScript(m, p.server, port, fit.ctx, p.accel));
  if (!isWindows) await Deno.chmod(script, 0o755);
  const want: Endpoint = {
    label: `${m.id} (local llama.cpp)`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: m.id,
    contextChars: fit.ctx * 3,
    tier: "full",
  };
  // The first start downloads several GB.
  const r = await startFull(want, 3 * 3600_000, signal);
  if (!r) return { error: `${script} disappeared` };
  if ("failure" in r) {
    const f = r.failure;
    return { error: `${m.id} did not start: ${describeFailure(f)}`, failure: f };
  }
  await record(memory, m, r.ep, script, p.accel);
  const layers = await offload(logPath("full"));
  return {
    ep: r.ep,
    summary: `${m.label} is running at ${r.ep.baseUrl} on ${p.accel}${
      layers ? ` (${layers})` : ""
    }, started by ${script}.${p.warning ? ` Warning: ${p.warning}` : ""}`,
  };
}
