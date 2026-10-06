// The fallback bootstrap: a prebuilt llama.cpp server for this platform,
// serving a small Qwen downloaded from Hugging Face on first use.

import { join } from "@std/path";
import { cacheDir, ensureDir, exists, isWindows } from "./platform.ts";
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
  stop(): void;
}

/** Starts llama-server and waits until the model is downloaded and loaded. */
export async function startLlama(server: string): Promise<Running> {
  const model = Deno.env.get("AIBOOT_BOOTSTRAP_MODEL") ?? DEFAULT_MODEL;
  const port = freePort(18080);
  const bin = join(server, "..");
  const logPath = join(cacheDir(), "llama", "server.log");
  const log = await Deno.open(logPath, { write: true, create: true, truncate: true });
  const models = join(cacheDir(), "models");
  const env: Record<string, string> = { LLAMA_CACHE: models };
  if (Deno.build.os === "linux") {
    env.LD_LIBRARY_PATH = [bin, Deno.env.get("LD_LIBRARY_PATH")].filter(Boolean).join(":");
  }
  info(`starting llama-server with ${model} on 127.0.0.1:${port} (log: ${logPath})`);
  const proc = new Deno.Command(server, {
    args: ["-hf", model, "--host", "127.0.0.1", "--port", String(port), "--jinja", "-c", "16384"],
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const tee = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) await log.write(c).catch(() => {});
  };
  tee(proc.stdout);
  tee(proc.stderr);
  let exited = false;
  proc.status.then(() => (exited = true));
  const t0 = Date.now();
  let shown = 0;
  let had = await dirSize(models);
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
          ? `  downloading the model (${el}s): ${gb(size)} so far, ${(rate / 1e6).toFixed(1)} MB/s`
          : `  waiting for the model (${el}s): ${await lastLine(logPath)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return {
    endpoint: {
      label: `${model.split("/").pop()} (local llama.cpp)`,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model,
      contextChars: contextFor(4, false),
    },
    stop: () => {
      try {
        proc.kill();
      } catch {
        // gone
      }
    },
  };
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
