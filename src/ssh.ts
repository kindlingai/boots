// Opening a hop: probe the remote, install the right ai-bootstrap binary in its
// cache directory (once per build), and start it as a far agent over ssh.

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
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

const RELEASES = "https://github.com/kindlingai/boots/releases/download";

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

/**
 * Where a far agent gets builds it does not have: the machine that started
 * it (set by far.ts). The local machine has none and downloads.
 */
type Upstream = (op: string, args: unknown) => Promise<any>;
let upstream: Upstream | null = null;

export function setUpstream(u: Upstream | null): void {
  upstream = u;
}

/** Bytes per binary_chunk: a few MB of base64 per RPC message. */
const CHUNK = 2 * 1024 * 1024;

/** sha256 hex of a release file, from the release's SHA256SUMS. */
export function checksumFor(sums: string, name: string): string | null {
  for (const line of sums.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

async function sha256(data: Uint8Array): Promise<string> {
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)));
}

/**
 * The binary in release package `pkg` under `base` (a releases/download/<tag>
 * URL), checked against that release's SHA256SUMS before it is unpacked.
 */
export async function downloadPackage(
  base: string,
  pkg: string,
  log: (s: string) => void,
): Promise<Uint8Array> {
  const url = `${base}/${pkg}`;
  log(`downloading ${url}`);
  const [r, s] = await Promise.all([fetch(url), fetch(`${base}/SHA256SUMS`)]);
  if (!r.ok) {
    await r.body?.cancel();
    await s.body?.cancel();
    throw new Error(`${url} returned ${r.status}`);
  }
  const data = new Uint8Array(await r.arrayBuffer());
  const want = s.ok ? checksumFor(await s.text(), pkg) : (await s.body?.cancel(), null);
  if (!want) throw new Error(`cannot verify ${pkg}: no checksum for it in ${base}/SHA256SUMS`);
  const got = await sha256(data);
  if (got !== want) {
    throw new Error(`${pkg} does not match its checksum (got ${got}, SHA256SUMS says ${want})`);
  }
  return await unpack(pkg, data);
}

/** Downloads this version's package for `target`, checked against SHA256SUMS. */
async function download(target: string, log: (s: string) => void): Promise<Uint8Array> {
  const base = `${Deno.env.get("AIBOOT_RELEASES") ?? RELEASES}/v${VERSION}`;
  log(`downloading the ${target} build`);
  try {
    return await downloadPackage(base, packageName(target), log);
  } catch (e) {
    throw new Error(
      `no ai-bootstrap build for ${target}: ${
        (e as Error).message
      }. Set AIBOOT_FAR_BINARY to a binary for that platform.`,
    );
  }
}

/** Fetches the build for `target` from the machine above, a chunk at a time. */
async function fromUpstream(up: Upstream, target: string, log: (s: string) => void) {
  const info = await up("binary_info", { target }) as { size: number; sha256: string };
  log(`fetching the ${target} build (${(info.size / 1e6).toFixed(0)} MB) from the machine above`);
  const out = new Uint8Array(info.size);
  for (let off = 0; off < info.size; off += CHUNK) {
    const r = await up("binary_chunk", { target, offset: off, length: CHUNK }) as { b64: string };
    out.set(decodeBase64(r.b64), off);
  }
  if (await sha256(out) !== info.sha256) {
    throw new Error(`the ${target} build from the machine above arrived damaged`);
  }
  return out;
}

/**
 * The ai-bootstrap executable for `target`: ourselves, the cache, the
 * machine above (on a hop), or a release download checked against its
 * SHA256SUMS. Builds of other versions in the cache are removed.
 */
export async function binaryFor(target: string, log: (s: string) => void): Promise<string> {
  const override = Deno.env.get("AIBOOT_FAR_BINARY");
  if (override) return override;
  if (target === currentTarget() && isCompiled()) return Deno.execPath();
  const root = join(cacheDir(), "bin");
  const dir = join(root, VERSION);
  const path = join(dir, `ai-bootstrap-${target}`);
  if (await exists(path)) return path;
  const bin = upstream ? await fromUpstream(upstream, target, log) : await download(target, log);
  await ensureDir(dir);
  const tmp = `${path}.part`;
  await Deno.writeFile(tmp, bin);
  await Deno.rename(tmp, path);
  if (!isWindows) await Deno.chmod(path, 0o755);
  await pruneLocal(root);
  return path;
}

/** Removes cached builds of other versions. */
async function pruneLocal(root: string): Promise<void> {
  try {
    for await (const e of Deno.readDir(root)) {
      if (e.isDirectory && e.name !== VERSION) {
        await Deno.remove(join(root, e.name), { recursive: true }).catch(() => {});
      }
    }
  } catch {
    // nothing cached
  }
}

/** Answers a hop below that needs a build it does not have (binary_info, binary_chunk). */
export async function serveBinary(op: string, args: any, log: (s: string) => void) {
  const path = await binaryFor(String(args.target), log);
  if (op === "binary_info") {
    return { size: (await Deno.stat(path)).size, sha256: await fullHash(path) };
  }
  const f = await Deno.open(path, { read: true });
  try {
    await f.seek(Number(args.offset) || 0, Deno.SeekMode.Start);
    const buf = new Uint8Array(Math.min(Number(args.length) || CHUNK, CHUNK));
    let n = 0;
    while (n < buf.length) {
      const r = await f.read(buf.subarray(n));
      if (r === null) break;
      n += r;
    }
    return { b64: encodeBase64(buf.subarray(0, n)) };
  } finally {
    f.close();
  }
}

const hashes = new Map<string, string>();

async function fullHash(path: string): Promise<string> {
  const st = await Deno.stat(path);
  const k = `${path}:${st.size}:${st.mtime?.getTime()}`;
  const hit = hashes.get(k);
  if (hit) return hit;
  const h = await sha256(await Deno.readFile(path));
  hashes.set(k, h);
  return h;
}

async function shortHash(path: string): Promise<string> {
  return (await fullHash(path)).slice(0, 16);
}

/**
 * Removes other builds from the remote's cache, except any still running
 * (an agent of another session), and upload leftovers older than an hour.
 */
export function pruneRemote(dir: string, keep: string): string {
  return `cd "${dir}" 2>/dev/null && for f in ai-bootstrap-*; do ` +
    `case "$f" in "${keep}"|"ai-bootstrap-*") continue;; *.tmp) continue;; esac; ` +
    `ps -eo args 2>/dev/null | grep -F -- "$f --far" | grep -qv grep && continue; ` +
    `rm -f -- "$f"; done; find . -name 'ai-bootstrap-*.tmp' -mmin +60 -exec rm -f {} + 2>/dev/null; true`;
}

const PROBE = `uname -s; uname -m; ${REMOTE_CACHE_SH}; echo "$c"; ` +
  `if command -v gzip >/dev/null 2>&1; then echo gzip; else echo plain; fi`;

export async function openSsh(
  dest: string,
  port: string | undefined,
  ask: Asker,
  log: (s: string) => void,
  onLine?: (token: string, line: string) => void,
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
    const name = remote.slice(remote.lastIndexOf("/") + 1);
    const have = await sshRun(
      dest,
      port,
      env,
      `sh -c 'test -x "${remote}" && echo yes || echo no; ${
        pruneRemote(`${rcache}/bin`, name).replace(/'/g, `'"'"'`)
      }'`,
    );
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
      if (op === "binary_info" || op === "binary_chunk") return serveBinary(op, args, log);
      if (op === "exec_line") {
        onLine?.(String(args.token), String(args.line));
        return Promise.resolve(true);
      }
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
