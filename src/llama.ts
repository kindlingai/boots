// The fallback bootstrap: a prebuilt llama.cpp server for this platform,
// serving a small Qwen downloaded from Hugging Face on first use.

import { join } from "@std/path";
import {
  cacheDir,
  ensureDir,
  exists,
  isWindows,
  modelsDir,
  randomFreePort,
  scriptsDir,
} from "./platform.ts";
import { BOOTSTRAP_SAMPLING, type Endpoint } from "./llm.ts";
import { contextFor } from "./discover.ts";
import { info } from "./ui.ts";
import { dirSize, DownloadWatch, logPath, scriptPath, supervise } from "./intelligence.ts";
import { downloadTo, Progress } from "./frontend.ts";

export { dirSize };

/** A release known to ship CPU builds for every platform below. */
const PINNED_TAG = "b9000";
export const DEFAULT_MODEL = "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M";

/**
 * "cpu" is the bootstrap build (Metal on macOS anyway). "gpu" is the
 * hardware-accelerated one for the full model: Vulkan on Linux and
 * Windows, which covers NVIDIA, AMD and Intel GPUs, and Metal on macOS.
 */
export type Flavor = "cpu" | "gpu";

function platformAsset(flavor: Flavor = "cpu"): { stem: string; ext: string } {
  const a = Deno.build.arch === "aarch64" ? "arm64" : "x64";
  const gpu = flavor === "gpu";
  switch (Deno.build.os) {
    case "linux":
      return { stem: gpu ? `ubuntu-vulkan-${a}` : `ubuntu-${a}`, ext: "tar.gz" };
    case "darwin":
      return { stem: `macos-${a}`, ext: "tar.gz" };
    case "windows":
      return { stem: gpu && a === "x64" ? "win-vulkan-x64" : `win-cpu-${a}`, ext: "zip" };
    default:
      throw new Error(`no prebuilt llama.cpp for ${Deno.build.os}`);
  }
}

/** macOS builds are the same for both. */
function rootFor(flavor: Flavor): string {
  return join(cacheDir(), flavor === "gpu" && Deno.build.os !== "darwin" ? "llama-gpu" : "llama");
}

async function latest(flavor: Flavor): Promise<{ tag: string; url: string } | null> {
  const { stem } = platformAsset(flavor);
  try {
    const r = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/vnd.github+json" },
    });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    const j = await r.json();
    const re = new RegExp(`-bin-${stem}\\.(tar\\.gz|zip)$`);
    const asset = (j.assets ?? []).find((x: any) => re.test(x.name));
    return asset ? { tag: j.tag_name, url: asset.browser_download_url } : null;
  } catch {
    return null;
  }
}

async function findServer(dir: string): Promise<string | null> {
  const want = isWindows ? "llama-server.exe" : "llama-server";
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isFile && e.name === want) return p;
    if (e.isDirectory) {
      const f = await findServer(p);
      if (f) return f;
    }
  }
  return null;
}

/** An already-installed llama-server, if any. */
export async function installedServer(flavor: Flavor = "cpu"): Promise<string | null> {
  const root = rootFor(flavor);
  if (!(await exists(root))) return null;
  return await findServer(root);
}

export async function installLlama(flavor: Flavor = "cpu"): Promise<string> {
  const have = await installedServer(flavor);
  if (have) return have;
  const pinned = Deno.env.get("AIBOOT_LLAMA_TAG");
  const { stem, ext } = platformAsset(flavor);
  const rel = pinned ? null : await latest(flavor);
  const tag = pinned ?? rel?.tag ?? PINNED_TAG;
  const url = rel?.url ??
    `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/llama-${tag}-bin-${stem}.${ext}`;
  const dir = join(rootFor(flavor), tag);
  await ensureDir(dir);
  const archive = join(dir, `llama.${ext}`);
  info(`downloading llama.cpp ${tag}: ${url}`);
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status}`);
  const f = await Deno.open(archive, { write: true, create: true, truncate: true });
  const p = new Progress(`llama-${flavor}`, `downloading llama.cpp ${tag}`);
  try {
    await downloadTo(r, f.writable, p);
  } finally {
    p.end();
  }
  // bsdtar (macOS, Windows 10+) reads zip as well as tar.gz.
  const x = await new Deno.Command("tar", {
    args: ["-xf", archive, "-C", dir],
    stdout: "null",
    stderr: "piped",
  })
    .output();
  if (x.code !== 0) {
    throw new Error(`extracting ${archive} failed: ${new TextDecoder().decode(x.stderr)}`);
  }
  await Deno.remove(archive);
  const server = await findServer(dir);
  if (!server) throw new Error(`no llama-server in ${url}`);
  if (!isWindows) await Deno.chmod(server, 0o755);
  return server;
}

export interface Running {
  endpoint: Endpoint;
  /** The script that starts it; the user can run it by hand too. */
  script: string;
  /** The llama-server it runs, to start it again. */
  server: string;
  stop(): void;
  /** Resolves once it has exited (and freed its memory). */
  exited: Promise<number>;
}

const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** start-bootstrap.sh: llama-server for the base model, in the foreground, on PORT (default `port`). */
export function bootstrapScript(
  server: string,
  model: string,
  cache: string,
  port: number,
  windows = isWindows,
) {
  const args = `-hf ${model} --host 127.0.0.1 --jinja -c 16384`;
  if (windows) {
    return [
      "@echo off",
      `rem Starts the bootstrap model: llama.cpp serving ${model}.`,
      "rem Written by ai-bootstrap each time it starts the model; edits are overwritten.",
      "rem usage: start-bootstrap.cmd [PORT]",
      `set "LLAMA_CACHE=${cache}"`,
      'set "port=%~1"',
      `if "%port%"=="" set "port=${port}"`,
      `"${server}" ${args} --port %port%`,
      "",
    ].join("\r\n");
  }
  const lib = Deno.build.os === "linux"
    ? `export LD_LIBRARY_PATH=${sq(join(server, ".."))}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\n`
    : "";
  return `#!/bin/sh
# Starts the bootstrap model: llama.cpp serving ${model}.
# Written by ai-bootstrap each time it starts the model; edits are overwritten.
# usage: start-bootstrap.sh [PORT]
export LLAMA_CACHE=${sq(cache)}
${lib}exec ${sq(server)} ${args} --port "\${1:-${port}}"
`;
}

/** The bootstrap's endpoint before it is started (no URL yet): see Router.ensureBootstrap. */
export function notStarted(): Endpoint {
  const model = Deno.env.get("AIBOOT_BOOTSTRAP_MODEL") ?? DEFAULT_MODEL;
  return {
    label: `${model.split("/").pop()} (local llama.cpp)`,
    baseUrl: "",
    model,
    contextChars: contextFor(4, false),
    sampling: BOOTSTRAP_SAMPLING,
  };
}

/** Models from before models/ existed were in the cache; move them rather than download again. */
async function moveOldModels(to: string) {
  const old = join(cacheDir(), "models");
  if (!(await exists(old)) || (await exists(to))) return;
  try {
    await ensureDir(join(to, ".."));
    await Deno.rename(old, to);
    info(`moved downloaded models from ${old} to ${to}`);
  } catch {
    // another disk: download again
  }
}

/** Writes start-bootstrap and runs it; waits until the model is downloaded and loaded. */
export async function startLlama(server: string): Promise<Running> {
  const model = Deno.env.get("AIBOOT_BOOTSTRAP_MODEL") ?? DEFAULT_MODEL;
  const port = randomFreePort();
  const models = join(modelsDir(), "llama.cpp");
  await moveOldModels(models);
  await ensureDir(models);
  await ensureDir(scriptsDir());
  await Deno.remove(join(scriptsDir(), isWindows ? "start-base.cmd" : "start-base.sh"))
    .catch(() => {});
  const script = scriptPath("bootstrap");
  await Deno.writeTextFile(script, bootstrapScript(server, model, models, port));
  if (!isWindows) await Deno.chmod(script, 0o755);
  const log = logPath("bootstrap");
  info(`starting ${model} on 127.0.0.1:${port} with ${script} (log: ${log})`);
  const proc = await supervise(script, [String(port)], log);
  const run: Running = {
    endpoint: {
      label: `${model.split("/").pop()} (local llama.cpp)`,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model,
      contextChars: contextFor(4, false),
      sampling: BOOTSTRAP_SAMPLING,
    },
    script,
    server,
    stop: () => proc.stop(),
    exited: proc.exited,
  };
  // The 4B Q4_K_M is about 2.5 GB.
  const progress = new Progress("bootstrap", `starting ${model.split("/").pop()}`);
  const watch = new DownloadWatch(models, progress, 2.5e9);
  try {
    while (true) {
      if (!proc.isRunning()) throw new Error(`llama-server exited; see ${log}`);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        const ok = r.ok && (await r.json()).status === "ok";
        if (ok) break;
      } catch {
        // not up yet
      }
      await watch.tick();
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    progress.end(false);
    run.stop();
    throw e;
  }
  progress.end();
  return run;
}
