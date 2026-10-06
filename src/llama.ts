// The fallback bootstrap: a prebuilt llama.cpp server for this platform,
// serving a small Qwen downloaded from Hugging Face on first use.

import { join } from "@std/path";
import { cacheDir, ensureDir, exists, isWindows, modelsDir, scriptsDir } from "./platform.ts";
import type { Endpoint } from "./llm.ts";
import { contextFor } from "./discover.ts";
import { info } from "./ui.ts";

/** A release known to ship CPU builds for every platform below. */
const PINNED_TAG = "b9000";
const DEFAULT_MODEL = "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M";

function platformAsset(): { stem: string; ext: string } {
  const a = Deno.build.arch === "aarch64" ? "arm64" : "x64";
  switch (Deno.build.os) {
    case "linux":
      return { stem: `ubuntu-${a}`, ext: "tar.gz" };
    case "darwin":
      return { stem: `macos-${a}`, ext: "tar.gz" };
    case "windows":
      return { stem: `win-cpu-${a}`, ext: "zip" };
    default:
      throw new Error(`no prebuilt llama.cpp for ${Deno.build.os}`);
  }
}

async function latest(): Promise<{ tag: string; url: string } | null> {
  const { stem } = platformAsset();
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
export async function installedServer(): Promise<string | null> {
  const root = join(cacheDir(), "llama");
  if (!(await exists(root))) return null;
  return await findServer(root);
}

export async function installLlama(): Promise<string> {
  const have = await installedServer();
  if (have) return have;
  const pinned = Deno.env.get("AIBOOT_LLAMA_TAG");
  const { stem, ext } = platformAsset();
  const rel = pinned ? null : await latest();
  const tag = pinned ?? rel?.tag ?? PINNED_TAG;
  const url = rel?.url ??
    `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/llama-${tag}-bin-${stem}.${ext}`;
  const dir = join(cacheDir(), "llama", tag);
  await ensureDir(dir);
  const archive = join(dir, `llama.${ext}`);
  info(`downloading llama.cpp ${tag}: ${url}`);
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status}`);
  const f = await Deno.open(archive, { write: true, create: true, truncate: true });
  await r.body.pipeTo(f.writable);
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

function freePort(prefer: number): number {
  for (const p of [prefer, 0]) {
    try {
      const l = Deno.listen({ hostname: "127.0.0.1", port: p });
      const port = (l.addr as Deno.NetAddr).port;
      l.close();
      return port;
    } catch {
      // taken
    }
  }
  throw new Error("no free port");
}

export interface Running {
  endpoint: Endpoint;
  /** The script that starts it; the user can run it by hand too. */
  script: string;
  stop(): void;
}

const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * The script that starts the base model: llama-server on PORT (default
 * 18080). Given PID, it stops the server when that process is gone, so
 * the server never outlives ai-bootstrap, even if ai-bootstrap is killed.
 */
export function baseScript(server: string, model: string, cache: string, windows = isWindows) {
  const args = `-hf ${model} --host 127.0.0.1 --jinja -c 16384`;
  if (windows) {
    return [
      "@echo off",
      `rem Starts the base intelligence: llama.cpp serving ${model}.`,
      "rem Written by ai-bootstrap each time it starts the model; edits are overwritten.",
      "rem usage: start-base.cmd [PORT]",
      `set "LLAMA_CACHE=${cache}"`,
      'set "port=%~1"',
      'if "%port%"=="" set "port=18080"',
      `"${server}" ${args} --port %port%`,
      "",
    ].join("\r\n");
  }
  const lib = Deno.build.os === "linux"
    ? `export LD_LIBRARY_PATH=${sq(join(server, ".."))}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\n`
    : "";
  return `#!/bin/sh
# Starts the base intelligence: llama.cpp serving ${model}.
# Written by ai-bootstrap each time it starts the model; edits are overwritten.
# usage: start-base.sh [PORT] [PID]   (with PID: stop when that process exits)
export LLAMA_CACHE=${sq(cache)}
${lib}port=\${1:-18080}
watch=\${2:-}
${sq(server)} ${args} --port "$port" &
pid=$!
trap 'kill "$pid" 2>/dev/null' INT TERM HUP
while kill -0 "$pid" 2>/dev/null; do
  if [ -n "$watch" ] && ! kill -0 "$watch" 2>/dev/null; then kill "$pid" 2>/dev/null; fi
  sleep 1
done
wait "$pid"
`;
}

/** Started models, stopped when ai-bootstrap exits, however it exits. */
const running = new Set<Running>();
let hooked = false;

function stopAllOnExit() {
  if (hooked) return;
  hooked = true;
  const all = () => [...running].forEach((r) => r.stop());
  globalThis.addEventListener("unload", all);
  if (!isWindows) {
    for (const sig of ["SIGTERM", "SIGHUP"] as const) {
      try {
        Deno.addSignalListener(sig, () => {
          all();
          Deno.exit(128 + (sig === "SIGTERM" ? 15 : 1));
        });
      } catch {
        // not supported here
      }
    }
  }
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

/** Writes the start script and runs it; waits until the model is downloaded and loaded. */
export async function startLlama(server: string): Promise<Running> {
  const model = Deno.env.get("AIBOOT_BOOTSTRAP_MODEL") ?? DEFAULT_MODEL;
  const port = freePort(18080);
  const models = join(modelsDir(), "llama.cpp");
  await moveOldModels(models);
  await ensureDir(models);
  await ensureDir(scriptsDir());
  const script = join(scriptsDir(), isWindows ? "start-base.cmd" : "start-base.sh");
  await Deno.writeTextFile(script, baseScript(server, model, models));
  if (!isWindows) await Deno.chmod(script, 0o755);
  await ensureDir(join(cacheDir(), "llama"));
  const logPath = join(cacheDir(), "llama", "server.log");
  const log = await Deno.open(logPath, { write: true, create: true, truncate: true });
  info(`starting ${model} on 127.0.0.1:${port} with ${script} (log: ${logPath})`);
  const proc = new Deno.Command(isWindows ? "cmd.exe" : "sh", {
    args: isWindows ? ["/d", "/c", script, String(port)] : [script, String(port), String(Deno.pid)],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let exited = false;
  const run: Running = {
    endpoint: {
      label: `${model.split("/").pop()} (local llama.cpp)`,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model,
      contextChars: contextFor(4, false),
    },
    script,
    stop: () => {
      running.delete(run);
      if (exited) return;
      try {
        if (isWindows) {
          // cmd.exe does not pass a kill on to llama-server: end the whole tree.
          new Deno.Command("taskkill", {
            args: ["/pid", String(proc.pid), "/t", "/f"],
            stdout: "null",
            stderr: "null",
          }).outputSync();
        } else proc.kill("SIGTERM");
      } catch {
        // gone
      }
    },
  };
  running.add(run);
  stopAllOnExit();
  const tee = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) await log.write(c).catch(() => {});
  };
  tee(proc.stdout);
  tee(proc.stderr);
  proc.status.then(() => (exited = true));
  const t0 = Date.now();
  let shown = 0;
  let had = await dirSize(models);
  try {
    while (true) {
      if (exited) throw new Error(`llama-server exited; see ${logPath}`);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        const ok = r.ok && (await r.json()).status === "ok";
        if (ok) break;
      } catch {
        // not up yet
      }
      const el = Math.floor((Date.now() - t0) / 1000);
      if (el - shown >= 10) {
        // llama-server draws download progress only on a terminal, so watch the cache grow.
        const size = await dirSize(models);
        const rate = (size - had) / (el - shown);
        shown = el;
        had = size;
        info(
          rate > 0
            ? `  downloading the model (${el}s): ${gb(size)} so far, ${
              (rate / 1e6).toFixed(1)
            } MB/s`
            : `  waiting for the model (${el}s): ${await lastLine(logPath)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    run.stop();
    throw e;
  }
  return run;
}

function gb(n: number): string {
  return `${(n / 1e9).toFixed(2)} GB`;
}

/** Bytes under `dir`, partial downloads included. */
export async function dirSize(dir: string): Promise<number> {
  let n = 0;
  try {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory) n += await dirSize(p);
      else if (e.isFile) n += (await Deno.stat(p).catch(() => ({ size: 0 }))).size;
    }
  } catch {
    // not there yet
  }
  return n;
}

async function lastLine(p: string): Promise<string> {
  try {
    const t = await Deno.readTextFile(p);
    const lines = t.split(/[\r\n]+/).filter((l) => l.trim());
    return (lines.at(-1) ?? "").slice(0, 120);
  } catch {
    return "";
  }
}
