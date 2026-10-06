// Opening a hop: probe the remote, install the right ai-bootstrap binary in its
// cache directory (once per build), and start it as a far agent over ssh.

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import type { Asker } from "./secrets.ts";
import { Rpc } from "./rpc.ts";
import { startAskpass } from "./askpass.ts";
import { packageName, unpack } from "./package.ts";
import type { HostInfo } from "./host.ts";
import {
  cacheDir,
  currentTarget,
  ensureDir,
  exists,
  isCompiled,
  isWindows,
  REMOTE_CACHE_SH,
  targetFromUname,
  VERSION,
} from "./platform.ts";

export interface SshChild {
  dest: string;
  rpc: Rpc;
  info: HostInfo;
  close(): Promise<void>;
}

const RELEASES = "https://github.com/mmastrac/ai-bootstrap/releases/download";

/** Unix socket paths are limited to ~104 bytes; %C adds 40. */
function controlDir(): string {
  const d = join(cacheDir(), "ssh");
  if (d.length <= 60) return d;
  return join(Deno.env.get("TMPDIR") ?? "/tmp", `ai-bootstrap-${Deno.uid() ?? "u"}`);
}

function sshBase(port?: string): string[] {
  const a = [
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=4",
    "-o",
    "NumberOfPasswordPrompts=3",
  ];
  if (!isWindows) {
    // One authentication covers the probe, the install and the agent.
    a.push("-o", "ControlMaster=auto", "-o", `ControlPath=${join(controlDir(), "%C")}`);
    a.push("-o", "ControlPersist=60");
  }
  if (port) a.push("-p", port);
  for (const w of (Deno.env.get("AIBOOT_SSH_OPTS") ?? "").split(" ")) if (w) a.push(w);
  return a;
}

async function sshRun(
  dest: string,
  port: string | undefined,
  env: Record<string, string>,
  remote: string,
  stdin?: ReadableStream<Uint8Array>,
): Promise<{ code: number; out: string; err: string }> {
  const p = new Deno.Command("ssh", {
    args: [...sshBase(port), dest, "--", remote],
    env,
    stdin: stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    // Out of the terminal's process group: ^C stops a command, not the connection.
    detached: !isWindows,
  }).spawn();
  if (stdin) await stdin.pipeTo(p.stdin).catch(() => {});
  const o = await p.output();
  const d = new TextDecoder();
  return { code: o.code, out: d.decode(o.stdout), err: d.decode(o.stderr).trim() };
}

/** The ai-bootstrap executable for `target`: ourselves, the cache, or a release download. */
export async function binaryFor(target: string, log: (s: string) => void): Promise<string> {
  const override = Deno.env.get("AIBOOT_FAR_BINARY");
  if (override) return override;
  if (target === currentTarget() && isCompiled()) return Deno.execPath();
  const dir = join(cacheDir(), "bin", VERSION);
  const path = join(dir, `ai-bootstrap-${target}`);
  if (await exists(path)) return path;
  const pkg = packageName(target);
  const url = `${Deno.env.get("AIBOOT_RELEASES") ?? RELEASES}/v${VERSION}/${pkg}`;
  log(`downloading the ${target} build from ${url}`);
  const r = await fetch(url);
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(
      `no ai-bootstrap build for ${target}: ${url} returned ${r.status}. Set AIBOOT_FAR_BINARY to a binary for that platform.`,
    );
  }
  const bin = await unpack(pkg, new Uint8Array(await r.arrayBuffer()));
  await ensureDir(dir);
  const tmp = `${path}.part`;
  await Deno.writeFile(tmp, bin);
  await Deno.rename(tmp, path);
  if (!isWindows) await Deno.chmod(path, 0o755);
  return path;
}

const hashes = new Map<string, string>();

async function shortHash(path: string): Promise<string> {
  const st = await Deno.stat(path);
  const k = `${path}:${st.size}:${st.mtime?.getTime()}`;
  const hit = hashes.get(k);
  if (hit) return hit;
  const h = encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(path))),
  );
  hashes.set(k, h.slice(0, 16));
  return h.slice(0, 16);
}

const PROBE = `uname -s; uname -m; ${REMOTE_CACHE_SH}; echo "$c"; ` +
  `if command -v gzip >/dev/null 2>&1; then echo gzip; else echo plain; fi`;

export async function openSsh(
  dest: string,
  port: string | undefined,
  ask: Asker,
  log: (s: string) => void,
): Promise<SshChild> {
  if (!isWindows) {
    await ensureDir(controlDir());
    await Deno.chmod(controlDir(), 0o700);
  }
  const askpass = await startAskpass(ask);
  try {
    const env = askpass.env;
    const probe = await sshRun(dest, port, env, `sh -c '${PROBE}'`);
    if (probe.code !== 0) {
      throw new Error(`ssh ${dest} failed: ${probe.err || `exit ${probe.code}`}`);
    }
    const [sys, machine, rcache, gz] = probe.out.trim().split("\n").map((s) => s.trim());
    const target = targetFromUname(sys ?? "", machine ?? "");
    if (!target) throw new Error(`${dest} is ${sys} ${machine}; ai-bootstrap has no build for it`);

    const local = await binaryFor(target, log);
    const remote = `${rcache}/bin/ai-bootstrap-${await shortHash(local)}`;
    const have = await sshRun(dest, port, env, `test -x '${remote}' && echo yes || echo no`);
    if (have.out.trim() !== "yes") {
      const size = (await Deno.stat(local)).size;
      log(`installing ai-bootstrap (${target}, ${(size / 1e6).toFixed(0)} MB) into ${remote}`);
      const file = await Deno.open(local, { read: true });
      const zip = gz === "gzip";
      const body = zip ? file.readable.pipeThrough(new CompressionStream("gzip")) : file.readable;
      const unpack = zip ? "gunzip -c" : "cat";
      const put = await sshRun(
        dest,
        port,
        env,
        `sh -c 'mkdir -p "${rcache}/bin" && ${unpack} > "${remote}.tmp" && chmod 755 "${remote}.tmp" && mv "${remote}.tmp" "${remote}"'`,
        body,
      );
      if (put.code !== 0) throw new Error(`installing on ${dest} failed: ${put.err}`);
    }

    const proc = new Deno.Command("ssh", {
      args: [...sshBase(port), dest, "--", `'${remote}' --far`],
      env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      detached: !isWindows,
    }).spawn();
    relay(proc.stderr, (l) => log(`[${dest}] ${l}`));
    const rpc = new Rpc(proc.stdout, proc.stdin, (l) => log(`[${dest}] ${l}`));
    let info: HostInfo;
    try {
      info = await timeout(
        rpc.call<HostInfo>("info"),
        60_000,
        `the agent on ${dest} did not answer`,
      );
    } catch (e) {
      try {
        proc.kill();
      } catch {
        // gone
      }
      throw e;
    }
    // The hop may ask for secrets later (sudo there, or a deeper ssh).
    rpc.handler = (op, args) => {
      if (op === "ask") return ask(args);
      return Promise.reject(new Error(`${dest} sent unexpected ${op}`));
    };
    return {
      dest,
      rpc,
      info,
      close: async () => {
        await rpc.close();
        const done = await Promise.race([
          proc.status.then(() => true),
          sleep(5000).then(() => false),
        ]);
        if (!done) {
          try {
            proc.kill();
          } catch {
            // gone
          }
        }
      },
    };
  } finally {
    // Keep answering while the far agent may still be authenticating.
    setTimeout(() => askpass.close(), 1000);
  }
}

function relay(stream: ReadableStream<Uint8Array>, out: (s: string) => void): void {
  (async () => {
    const d = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += d.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i).trimEnd();
        buf = buf.slice(i + 1);
        if (l) out(l);
      }
    }
    if (buf.trim()) out(buf.trim());
  })().catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function timeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(msg)), ms))),
  ]);
}
