// The models ai-bootstrap starts itself, each from a script in the startup
// scripts folder: start-bootstrap.sh (the small base model) and start-full.sh
// (the full model, written by the agent). A start script runs its server in
// the foreground; ai-bootstrap runs it under supervise.sh, which stops the
// server and everything it started when ai-bootstrap exits, even on kill -9.

import { join } from "@std/path";
import { ensureDir, exists, isWindows, modelsDir, scriptsDir } from "./platform.ts";
import { chat, type Endpoint, reachable } from "./llm.ts";
import { info } from "./ui.ts";

export const SUPERVISE_SH = `#!/bin/sh
# Written by ai-bootstrap. usage: supervise.sh PID SCRIPT [ARGS...]
# Runs SCRIPT (a model server, in the foreground) and stops it, with all it
# started, when process PID exits or this is signalled. ai-bootstrap starts
# this as a process group leader, so "kill 0" reaches the whole tree.
watch=$1
shift
sh "$@" 2>&1 &
pid=$!
stop() { trap '' TERM; kill -TERM 0 2>/dev/null; }
trap 'stop; exit 143' INT TERM HUP
while kill -0 "$pid" 2>/dev/null; do
  kill -0 "$watch" 2>/dev/null || { stop; exit 0; }
  sleep 1
done
wait "$pid"
`;

export function scriptPath(name: "bootstrap" | "full"): string {
  return join(scriptsDir(), `start-${name}.${isWindows ? "cmd" : "sh"}`);
}

export function logPath(name: "bootstrap" | "full"): string {
  return join(scriptsDir(), `${name}.log`);
}

/** full.log -> full.prev.log */
export function prevLog(log: string): string {
  return log.replace(/\.log$/, ".prev.log");
}

/** The last `n` lines of a log for reading, and the lines that mention errors. */
export async function readLog(path: string, n = 30): Promise<string> {
  const { tail, errors } = await logSummary(path, Math.min(Math.max(n, 1), 200));
  if (!tail.length) return `${path} is empty or missing`;
  return `last ${tail.length} lines of ${path}:\n${tail.join("\n")}\n\nlines mentioning errors:\n${
    errors.join("\n") || "(none)"
  }`;
}

export interface Supervised {
  script: string;
  log: string;
  /** Resolves when the server's process exits. */
  exited: Promise<number>;
  isRunning(): boolean;
  stop(): void;
}

/** Started servers, stopped when ai-bootstrap exits, however it exits. */
const running = new Set<Supervised>();
let hooked = false;

function stopAllOnExit() {
  if (hooked) return;
  hooked = true;
  const all = () => [...running].forEach((r) => r.stop());
  globalThis.addEventListener("unload", all);
  if (isWindows) return;
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

/** Runs a start script under supervision, its output going to `log` (truncated). */
export async function supervise(script: string, args: string[], log: string): Promise<Supervised> {
  await ensureDir(scriptsDir());
  // Keep the previous attempt's log: a retry would otherwise hide why the first one failed.
  await Deno.rename(log, prevLog(log)).catch(() => {});
  const out = await Deno.open(log, { write: true, create: true, truncate: true });
  let cmd: Deno.Command;
  if (isWindows) {
    cmd = new Deno.Command("cmd.exe", {
      args: ["/d", "/c", script, ...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
  } else {
    const sup = join(scriptsDir(), "supervise.sh");
    await Deno.writeTextFile(sup, SUPERVISE_SH);
    cmd = new Deno.Command("sh", {
      args: [sup, String(Deno.pid), script, ...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      detached: true,
    });
  }
  const proc = cmd.spawn();
  let done = false;
  const tee = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) await out.write(c).catch(() => {});
  };
  const teed = Promise.all([tee(proc.stdout), tee(proc.stderr)]);
  const exited = proc.status.then(async (s) => {
    done = true;
    running.delete(sup);
    await teed.catch(() => {});
    out.close();
    return s.code;
  });
  const sup: Supervised = {
    script,
    log,
    exited,
    isRunning: () => !done,
    stop: () => {
      running.delete(sup);
      if (done) return;
      try {
        if (isWindows) {
          // cmd.exe does not pass a kill on to the server: end the whole tree.
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
  running.add(sup);
  stopAllOnExit();
  return sup;
}

/** The last `n` non-blank lines of a log, and the last `n` that mention an error. */
export async function logSummary(
  path: string,
  n = 5,
): Promise<{ tail: string[]; errors: string[] }> {
  let text = "";
  try {
    text = await Deno.readTextFile(path);
  } catch {
    // no log
  }
  // Progress bars redraw with \r; keep the last state of each line.
  const lines = text.split("\n").map((l) => l.split("\r").filter((p) => p.trim()).pop() ?? "")
    .map((l) => l.trimEnd().slice(0, 400)).filter((l) => l.trim());
  return {
    tail: lines.slice(-n),
    errors: lines.filter((l) => /error/i.test(l)).slice(-n),
  };
}

/** Why the full model did not start, for the diagnosis prompt and the start_full_model tool. */
export type FailureCause = "disk" | "download" | "memory" | "gpu" | "other";

export interface FullFailure {
  script: string;
  log: string;
  reason: string;
  tail: string[];
  errors: string[];
  /** The likely cause, from the log (and whether the download was still going). */
  cause?: FailureCause;
}

/** What a failed start's log says, most specific first. */
export function causeOf(lines: string[], downloading: boolean): FailureCause {
  const t = lines.join("\n");
  if (/no space left|ENOSPC|os error 28|disk (is )?full|not enough (free )?(disk|space)/i.test(t)) {
    return "disk";
  }
  if (
    /out of memory|failed to allocate|insufficient memory|not enough memory|OutOfMemory|cannot allocate/i
      .test(t)
  ) {
    return "memory";
  }
  if (
    downloading ||
    /download|curl|HTTP (error|status)|status code|SSL|TLS|connection|could not resolve|timed out|failed to fetch|hf_hub|huggingface/i
      .test(t)
  ) {
    return "download";
  }
  if (/vulkan|metal|no (usable )?gpu|ggml_backend.*fail/i.test(t)) return "gpu";
  return "other";
}

export const CAUSE_HINT: Record<FailureCause, string> = {
  disk:
    "the disk is full. Warn the user. remove_downloads deletes unfinished and unused model downloads; otherwise the user must free space. list_models shows how much each model needs.",
  download:
    "the model download was interrupted (ai-bootstrap already resumed it automatically, and it still failed). Check the network; then try again with start_full_model, which continues the download.",
  memory:
    "it ran out of memory loading the model. Set up the next smaller model that fits (set_up_model).",
  gpu: "llama.cpp could not use the GPU. Read the log (read_log) and tell the user what it says.",
  other: "unclear. Read more of the log (read_log) and tell the user what it says.",
};

export function describeFailure(f: FullFailure): string {
  const block = (l: string[]) => l.length ? l.join("\n") : "(none)";
  return `${f.reason}\n${
    f.cause ? `likely cause: ${CAUSE_HINT[f.cause]}\n` : ""
  }script: ${f.script}\nlog: ${f.log}\n\nlast lines of the log:\n${
    block(f.tail)
  }\n\nlines mentioning errors:\n${block(f.errors)}`;
}

/** Up and loaded: it lists models and completes a tiny chat (servers list before loading). */
async function answers(ep: Endpoint): Promise<boolean> {
  if (!(await reachable(ep))) return false;
  try {
    await chat(
      ep,
      [{ role: "user", content: "Reply with the word ok." }],
      [],
      {},
      AbortSignal.timeout(60_000),
      0,
    );
    return true;
  } catch {
    return false;
  }
}

/** `# endpoint: <base_url> <model>` in start-full.sh says what it serves. */
export function endpointFromScript(text: string): { baseUrl: string; model: string } | null {
  const m = text.match(/^\s*(?:#|rem|::)\s*endpoint:\s*(\S+)\s+(\S+)/im);
  return m ? { baseUrl: m[1].replace(/\/$/, ""), model: m[2] } : null;
}

let full: Supervised | null = null;

/**
 * Runs start-full.sh and waits until `ep` answers. null when there is no
 * script; otherwise the endpoint, or why it failed.
 */
export async function startFull(
  fallback: Endpoint | null,
  timeoutMs = Number(Deno.env.get("AIBOOT_FULL_TIMEOUT_S") ?? 1200) * 1000,
  signal?: AbortSignal,
): Promise<{ ep: Endpoint } | { failure: FullFailure } | null> {
  const script = scriptPath("full");
  if (!(await exists(script))) return null;
  const log = logPath("full");
  const fail = async (reason: string) => {
    full?.stop();
    full = null;
    return { failure: { script, log, reason, ...(await logSummary(log)) } };
  };
  const declared = endpointFromScript(await Deno.readTextFile(script));
  const ep: Endpoint | null = declared
    ? fallback && fallback.baseUrl.replace(/\/$/, "") === declared.baseUrl &&
        fallback.model === declared.model
      ? fallback
      : { label: declared.model, ...declared, contextChars: fallback?.contextChars ?? 64_000 }
    : fallback;
  if (!ep) {
    return await fail(
      "the script has no `# endpoint: <base_url> <model>` line, so ai-bootstrap cannot tell when it is up",
    );
  }
  for (let attempt = 1;; attempt++) {
    const r = await runFull(ep, script, log, timeoutMs, signal);
    if ("ep" in r) return r;
    const summary = await logSummary(log);
    const cause = causeOf([r.reason, ...summary.tail, ...summary.errors], r.downloading);
    full?.stop();
    full = null;
    // An interrupted download resumes where it stopped: try again, a few times.
    if (cause === "download" && !r.final && attempt < DOWNLOAD_ATTEMPTS) {
      info(
        `  the download was interrupted; resuming (attempt ${attempt + 1} of ${DOWNLOAD_ATTEMPTS})`,
      );
      await new Promise((res) => setTimeout(res, 5000 * attempt));
      continue;
    }
    return { failure: { script, log, reason: r.reason, ...summary, cause } };
  }
}

const DOWNLOAD_ATTEMPTS = 3;

/** One start: up, or why not (and whether the model folder was still growing). */
async function runFull(
  ep: Endpoint,
  script: string,
  log: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ep: Endpoint } | { reason: string; downloading: boolean; final?: boolean }> {
  full?.stop();
  info(`starting the full model ${ep.model} with ${script} (log: ${log})`);
  try {
    full = await supervise(script, [], log);
  } catch (e) {
    // e.g. no space left for the log itself.
    return { reason: (e as Error).message, downloading: false, final: true };
  }
  const t0 = Date.now();
  let shown = 0;
  let had = await dirSize(modelsDir());
  let growing = false;
  while (true) {
    if (await answers(ep)) return { ep };
    if (signal?.aborted) return { reason: "stopped by the user", downloading: false, final: true };
    if (!full.isRunning()) {
      // Did the folder grow since the last look? Then it died mid-download.
      const size = await dirSize(modelsDir());
      return {
        reason: `start-full exited with status ${await full.exited} before ${ep.baseUrl} answered`,
        downloading: growing || size > had,
      };
    }
    const el = Math.floor((Date.now() - t0) / 1000);
    if (Date.now() - t0 > timeoutMs) {
      return {
        reason: `${ep.baseUrl} did not answer within ${el}s`,
        downloading: false,
        final: true,
      };
    }
    if (el - shown >= 15) {
      const size = await dirSize(modelsDir());
      const rate = (size - had) / (el - shown);
      growing = rate > 0;
      shown = el;
      had = size;
      const { tail } = await logSummary(log, 1);
      info(
        rate > 0
          ? `  waiting for the full model (${el}s): models folder ${gb(size)}, growing ${
            (rate / 1e6).toFixed(1)
          } MB/s`
          : `  waiting for the full model (${el}s): ${(tail[0] ?? "").slice(0, 120)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export function stopFull(): void {
  full?.stop();
  full = null;
}

export function gb(n: number): string {
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
