// What one machine can do: run commands, read and write files, sudo, and
// open an ssh hop to the next machine. The near side and every far agent
// run the same Host; requests addressed `via` a child hop are forwarded.

import { dirname, isAbsolute, join } from "@std/path";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import type { Asker } from "./secrets.ts";
import { hardwareSummary } from "./hardware.ts";
import {
  cacheDir,
  currentTarget,
  isWindows,
  modelsDir,
  randomFreePort,
  scriptsDir,
  VERSION,
} from "./platform.ts";
import { openSsh, type SshChild } from "./ssh.ts";

export interface HostInfo {
  os: string;
  /** Human name and version, e.g. "Ubuntu 24.04.1 LTS", "macOS 15.3 (24D60)". */
  osName: string;
  arch: string;
  target: string;
  hostname: string;
  user: string;
  home: string;
  shell: string;
  cwd: string;
  version: string;
  /** Where model weights and startup scripts belong on this machine. */
  models: string;
  scripts: string;
  /** A random free high port here, for the next server set up on this machine. */
  freePort: number;
  /** CPU, memory, GPUs and free disk, in one line. */
  hardware: string;
  /** This machine's scratch directory ($BOOTS_SCRATCH): free to write, removed at exit. */
  scratch?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** Stopped by the user (^C). */
  cancelled?: boolean;
  /** The command, as the caller sent it. */
  cmd?: string;
  cwd?: string;
}

/** How long a command may run unless the caller asks for longer. */
export const DEFAULT_TIMEOUT_MS = 30_000;

const CWD_MARK = "\x1eAIBOOT-CWD ";
const SUDO_REJECTED =
  /incorrect password|sorry, try again|no password was provided|password is required/i;

export class Host {
  cwd = Deno.cwd();
  private children = new Map<string, SshChild>();
  private nextChild = 1;
  private shellPath: string | null = null;
  private osNameCache: string | null = null;
  /** Commands in flight, by the token their caller can cancel them with. */
  private running = new Map<string, AbortController>();

  /**
   * Gets the latest output line of a running command, by its token: shown
   * live by the frontend here, sent up the hop chain on a far agent.
   */
  onLine: ((token: string, line: string) => void) | null = null;

  constructor(private ask: Asker, private log: (s: string) => void = () => {}) {}

  /** A throttled line reporter for the command with this token (none without one). */
  private liner(token: unknown): ((line: string) => void) | undefined {
    if (!token || !this.onLine) return undefined;
    const t = String(token);
    let last = 0;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      timer = undefined;
      last = Date.now();
      if (pending !== null) this.onLine?.(t, pending);
      pending = null;
    };
    return (line) => {
      pending = line;
      if (timer) return;
      timer = setTimeout(send, Math.max(0, 300 - (Date.now() - last)));
    };
  }

  async handle(op: string, args: any, via: string[]): Promise<unknown> {
    if (via.length) {
      const c = this.children.get(via[0]);
      if (!c) throw new Error(`no such hop ${via[0]}`);
      return await c.rpc.call(op, args, via.slice(1));
    }
    switch (op) {
      case "ping":
        return "pong";
      case "info":
        return await this.info();
      case "exec":
        return await this.cancellable(
          args.token,
          (signal) => this.exec(String(args.cmd), args.timeoutMs, signal, this.liner(args.token)),
        );
      case "sudo":
        return await this.cancellable(
          args.token,
          (signal) => this.sudo(String(args.cmd), args.timeoutMs, signal, this.liner(args.token)),
        );
      case "cancel":
        this.running.get(String(args.token))?.abort();
        return true;
      case "read":
        return await this.read(String(args.path), args.maxBytes);
      case "write":
        return await this.write(
          String(args.path),
          String(args.b64 ?? ""),
          args.mode,
          !!args.scratch,
        );
      case "git_clone":
        return await this.gitClone(String(args.url), args.ref ? String(args.ref) : undefined);
      case "ssh_open":
        return await this.sshOpen(String(args.dest), args.port);
      case "ssh_close":
        return await this.sshClose(String(args.id));
      default:
        throw new Error(`unknown op ${op}`);
    }
  }

  async info(): Promise<HostInfo> {
    const env = Deno.env.toObject();
    return {
      os: Deno.build.os,
      osName: await this.osName(),
      arch: Deno.build.arch,
      target: currentTarget(),
      hostname: Deno.hostname(),
      user: env.USER ?? env.USERNAME ?? env.LOGNAME ?? "?",
      home: env.HOME ?? env.USERPROFILE ?? "?",
      shell: isWindows ? "powershell" : await this.shell(),
      cwd: this.cwd,
      version: VERSION,
      models: modelsDir(),
      scripts: scriptsDir(),
      freePort: randomFreePort(),
      hardware: await hardwareSummary(),
      scratch: this.scratch(),
    };
  }

  private async osName(): Promise<string> {
    if (this.osNameCache) return this.osNameCache;
    const run = async (cmd: string, args: string[]) => {
      try {
        const o = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).output();
        return o.code === 0 ? new TextDecoder().decode(o.stdout).trim() : "";
      } catch {
        return "";
      }
    };
    let name = "";
    if (Deno.build.os === "linux") {
      const rel = await Deno.readTextFile("/etc/os-release").catch(() => "");
      name = rel.match(/^PRETTY_NAME="?([^"\n]*)"?/m)?.[1] ?? "Linux";
      if (/microsoft|WSL/i.test(Deno.osRelease())) name += " (WSL)";
      name += `, kernel ${Deno.osRelease()}`;
    } else if (Deno.build.os === "darwin") {
      const [prod, ver, build] = await Promise.all([
        run("sw_vers", ["-productName"]),
        run("sw_vers", ["-productVersion"]),
        run("sw_vers", ["-buildVersion"]),
      ]);
      name = `${prod || "macOS"} ${ver}${build ? ` (${build})` : ""}`.trim();
    } else if (Deno.build.os === "windows") {
      const caption = await run("powershell", [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_OperatingSystem).Caption",
      ]);
      name = `${caption || "Windows"} (build ${Deno.osRelease()})`;
    } else {
      name = `${Deno.build.os} ${Deno.osRelease()}`;
    }
    return (this.osNameCache = name);
  }

  private async shell(): Promise<string> {
    if (this.shellPath) return this.shellPath;
    for (const s of ["/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
      try {
        await Deno.stat(s);
        return (this.shellPath = s);
      } catch {
        // try the next
      }
    }
    return (this.shellPath = "sh");
  }

  /** The command, then a marker carrying the final cwd so `cd` persists. */
  private wrap(cmd: string): string {
    if (isWindows) {
      return `${cmd}\n$__rc = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n` +
        `Write-Output ([char]0x1e + "${CWD_MARK.slice(1)}" + (Get-Location).Path)\nexit $__rc`;
    }
    return `{\n${cmd}\n} </dev/null\n__aiboot_rc=$?\nprintf '\\n${
      CWD_MARK.replace("\x1e", "\\036")
    }%s\\n' "$(pwd)"\nexit $__aiboot_rc`;
  }

  private async cancellable<T>(
    token: unknown,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ac = new AbortController();
    const key = token ? String(token) : null;
    if (key) this.running.set(key, ac);
    try {
      return await run(ac.signal);
    } finally {
      if (key) this.running.delete(key);
    }
  }

  /**
   * Runs a command in its own process group (so the terminal's ^C does not
   * reach it), and on timeout or cancel takes the whole tree down: TERM,
   * then KILL two seconds later.
   */
  private async spawn(
    argv: string[],
    opts: {
      stdin?: string;
      timeoutMs?: number;
      cwd?: string;
      signal?: AbortSignal;
      /** Called with the latest output line as it arrives. */
      onLine?: (line: string) => void;
    },
  ) {
    const ms = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let cancelled = false;
    let p: Deno.ChildProcess;
    let done = false;
    const kill = (sig: Deno.Signal) => {
      if (done) return;
      try {
        if (isWindows) {
          new Deno.Command("taskkill", {
            args: ["/pid", String(p.pid), "/t", "/f"],
            stdout: "null",
            stderr: "null",
          }).outputSync();
        } else Deno.kill(-p.pid, sig);
      } catch {
        // Gone, or not ours to signal: a command run with sudo is root's
        // (EPERM), so ask sudo to signal it, with the credentials it cached
        // when it started (-n: never prompt).
        if (!isWindows && argv[0] === "sudo") {
          new Deno.Command("sudo", {
            args: ["-n", "kill", "-s", sig.replace(/^SIG/, ""), "--", `-${p.pid}`],
            stdin: "null",
            stdout: "null",
            stderr: "null",
          }).output().catch(() => {});
        }
      }
    };
    let hard: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      kill("SIGTERM");
      hard = setTimeout(() => kill("SIGKILL"), 2000);
    };
    const t = setTimeout(() => {
      timedOut = true;
      stop();
    }, ms);
    const onCancel = () => {
      cancelled = true;
      stop();
    };
    try {
      p = new Deno.Command(argv[0], {
        args: argv.slice(1),
        cwd: opts.cwd ?? this.cwd,
        stdin: opts.stdin !== undefined ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
        detached: !isWindows,
        // Free for the model to write: the variable points at this host's scratch.
        env: { BOOTS_SCRATCH: this.scratch() },
      }).spawn();
      if (opts.signal?.aborted) onCancel();
      opts.signal?.addEventListener("abort", onCancel);
      if (opts.stdin !== undefined) {
        const w = p.stdin.getWriter();
        await w.write(new TextEncoder().encode(opts.stdin)).catch(() => {});
        await w.close().catch(() => {});
      }
      // Read both streams as they come, so the latest line can be shown live.
      const collect = async (s: ReadableStream<Uint8Array>) => {
        const dec = new TextDecoder();
        let text = "";
        for await (const chunk of s) {
          const piece = dec.decode(chunk, { stream: true });
          text += piece;
          if (opts.onLine) {
            const line = lastLine(piece);
            if (line) opts.onLine(line);
          }
        }
        return text + dec.decode();
      };
      const [stdout, stderr, status] = await Promise.all([
        collect(p.stdout),
        collect(p.stderr),
        p.status,
      ]);
      done = true;
      return { code: status.code, stdout, stderr, timedOut, cancelled };
    } catch (e) {
      return { code: 127, stdout: "", stderr: (e as Error).message, timedOut, cancelled };
    } finally {
      done = true;
      clearTimeout(t);
      clearTimeout(hard);
      opts.signal?.removeEventListener("abort", onCancel);
    }
  }

  private finish(r: ExecResult): ExecResult {
    const at = r.stdout.lastIndexOf(CWD_MARK);
    if (at >= 0) {
      const cwd = r.stdout.slice(at + CWD_MARK.length).trim();
      r.stdout = r.stdout.slice(0, at).replace(/\r?\n$/, "");
      if (cwd && cwd !== this.cwd) {
        this.cwd = cwd;
        r.cwd = cwd;
      }
    }
    if (r.cancelled) r.stderr += "\n(stopped by the user)";
    else if (r.timedOut) r.stderr += "\n(timed out; it and everything it started were stopped)";
    return r;
  }

  private shellArgv(sh: string, script: string): string[] {
    return isWindows
      ? ["powershell", "-NoProfile", "-NonInteractive", "-Command", script]
      : [sh, "-c", script];
  }

  async exec(
    cmd: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    onLine?: (line: string) => void,
  ): Promise<ExecResult> {
    const sh = await this.shell();
    return this.finish(
      await this.spawn(this.shellArgv(sh, this.wrap(cmd)), { timeoutMs, signal, onLine }),
    );
  }

  /** Runs as root, asking up the hop chain for a password only if sudo wants one. */
  async sudo(
    cmd: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    onLine?: (line: string) => void,
  ): Promise<ExecResult> {
    if (isWindows) return { code: 1, stdout: "", stderr: "sudo is not available on Windows hosts" };
    const sh = await this.shell();
    const script = this.wrap(cmd);
    const quick = await this.spawn(["sudo", "-n", "true"], { timeoutMs: 15_000 });
    if (quick.code === 0) {
      return this.finish(
        await this.spawn(["sudo", "-n", sh, "-c", script], { timeoutMs, signal, onLine }),
      );
    }
    if (quick.code === 127) return { code: 127, stdout: "", stderr: "sudo is not installed here" };
    const i = await this.info();
    for (let attempt = 0; attempt < 3; attempt++) {
      const pw = await this.ask({
        kind: "sudo",
        path: [],
        prompt: `[sudo] password for ${i.user}@${i.hostname}`,
        attempt,
      });
      if (pw === null) {
        return { code: 1, stdout: "", stderr: "cancelled: no sudo password was given" };
      }
      const v = await this.spawn(["sudo", "-S", "-p", "", "-v"], {
        stdin: pw + "\n",
        timeoutMs: 30_000,
      });
      if (v.code !== 0) {
        if (SUDO_REJECTED.test(v.stderr)) continue;
        return { code: v.code, stdout: "", stderr: v.stderr.trim() || "sudo refused" };
      }
      // The shell runs with -c and the command with </dev/null, so the
      // password left on stdin is never read by anything but sudo.
      return this.finish(
        await this.spawn(["sudo", "-S", "-p", "", sh, "-c", script], {
          stdin: pw + "\n",
          timeoutMs,
          signal,
          onLine,
        }),
      );
    }
    return { code: 1, stdout: "", stderr: "sudo: three incorrect password attempts" };
  }

  private resolve(p: string): string {
    if (p.startsWith("~/") || p === "~") {
      const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
      return join(home, p.slice(1));
    }
    return isAbsolute(p) ? p : join(this.cwd, p);
  }

  async read(path: string, maxBytes = 64 * 1024) {
    const full = this.resolve(path);
    const data = await Deno.readFile(full);
    const head = data.subarray(0, maxBytes);
    if (head.includes(0)) return { path: full, size: data.length, binary: true, content: "" };
    return {
      path: full,
      size: data.length,
      truncated: data.length > maxBytes,
      content: new TextDecoder().decode(head),
    };
  }

  /**
   * Writes a file as a new one: whatever is at the path (a file, a symlink,
   * a pipe) is unlinked first and the file created exclusively, so a write
   * never follows a symlink or feeds a pipe. A directory is refused. An
   * existing file's permissions are kept unless `mode` is given. With
   * `scratch`, the file must land inside this host's scratch directory (its
   * folder resolved, symlinks and all).
   */
  async write(path: string, b64: string, mode?: string, scratch = false) {
    const full = this.resolve(path.replace(/^\$\{?BOOTS_SCRATCH\}?(?=\/|$)/, this.scratch()));
    await Deno.mkdir(dirname(full), { recursive: true });
    if (scratch) {
      const inside = await Deno.realPath(this.scratch());
      const dir = await Deno.realPath(dirname(full));
      if (dir !== inside && !dir.startsWith(inside + (isWindows ? "\\" : "/"))) {
        throw new Error(`${full} is not inside the scratch directory ${this.scratch()}`);
      }
    }
    let keep: number | undefined;
    try {
      const st = await Deno.lstat(full);
      if (st.isDirectory) throw new Error(`${full} is a directory`);
      if (st.isFile && st.mode !== null) keep = st.mode & 0o7777;
      await Deno.remove(full);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    const bytes = decodeBase64(b64);
    const want = mode ? parseInt(mode, 8) : keep ?? 0o644;
    const f = await Deno.open(full, { write: true, createNew: true, mode: want });
    try {
      for (let at = 0; at < bytes.length;) at += await f.write(bytes.subarray(at));
    } finally {
      f.close();
    }
    if (!isWindows && (mode || keep !== undefined)) await Deno.chmod(full, want);
    return { path: full, bytes: bytes.length };
  }

  private scratchDir: string | null = null;

  /**
   * This host's scratch directory, made on first use: private (0700) under
   * the system temp folder, linked from <cache>/scratch, removed when
   * ai-bootstrap exits. Leftovers of crashed sessions older than a day go.
   */
  scratch(): string {
    if (this.scratchDir) return this.scratchDir;
    const tmp = isWindows ? undefined : "/tmp";
    for (
      const e of (() => {
        try {
          return [...Deno.readDirSync(tmp ?? Deno.env.get("TEMP") ?? ".")];
        } catch {
          return [];
        }
      })()
    ) {
      if (!e.isDirectory || !e.name.startsWith("boots-scratch-")) continue;
      const p = join(tmp ?? Deno.env.get("TEMP") ?? ".", e.name);
      try {
        const st = Deno.statSync(p);
        if (st.mtime && Date.now() - st.mtime.getTime() > 86_400_000) {
          Deno.removeSync(p, { recursive: true });
        }
      } catch {
        // someone else's, or gone
      }
    }
    const dir = Deno.makeTempDirSync({ dir: tmp, prefix: "boots-scratch-" });
    this.scratchDir = dir;
    try {
      const link = join(cacheDir(), "scratch");
      Deno.mkdirSync(cacheDir(), { recursive: true });
      try {
        if (Deno.lstatSync(link).isSymlink) Deno.removeSync(link);
      } catch {
        // none yet
      }
      Deno.symlinkSync(dir, link);
    } catch {
      // a convenience: the variable is what counts
    }
    globalThis.addEventListener("unload", () => {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch {
        // already gone
      }
    });
    return dir;
  }

  /**
   * Shallow clone into a fresh temp folder. Read-only for the rest of the
   * system: no credentials are asked for, hooks and submodules don't run.
   */
  async gitClone(url: string, ref?: string) {
    if (!/^(https?:\/\/|git@[\w.-]+:|ssh:\/\/|file:\/\/)/.test(url) || /\s/.test(url)) {
      return { error: "use an https, ssh://, git@host:path or file:// URL" };
    }
    if (ref && !/^[\w./-]+$/.test(ref)) return { error: "bad ref" };
    const dir = await Deno.makeTempDir({ prefix: "ai-bootstrap-clone-" });
    const path = join(dir, (url.split(/[/:]/).pop() ?? "repo").replace(/\.git$/, "") || "repo");
    const args = [
      "-c",
      "core.hooksPath=" + (isWindows ? "NUL" : "/dev/null"),
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-recurse-submodules",
      ...(ref ? ["--branch", ref] : []),
      "--",
      url,
      path,
    ];
    const o = await new Deno.Command("git", {
      args,
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: isWindows ? "echo" : "/bin/false",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(5 * 60_000),
    }).output().catch((e) => ({
      code: 127,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode(e.message),
    }));
    if (o.code !== 0) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      return { error: new TextDecoder().decode(o.stderr).trim().split("\n").slice(-3).join("\n") };
    }
    const files: string[] = [];
    let readme = "";
    for await (const e of Deno.readDir(path)) {
      if (e.name === ".git") continue;
      files.push(e.isDirectory ? `${e.name}/` : e.name);
      if (!readme && /^readme(\.md|\.txt|\.rst)?$/i.test(e.name)) {
        readme = (await Deno.readTextFile(join(path, e.name)).catch(() => "")).slice(0, 3000);
      }
    }
    return { path, files: files.sort(), readme };
  }

  async sshOpen(dest: string, port?: number | string) {
    // Whatever the new hop asks for is asked on behalf of `dest`.
    const childAsk: Asker = (req) => this.ask({ ...req, path: [dest, ...req.path] });
    const child = await openSsh(
      dest,
      port ? String(port) : undefined,
      childAsk,
      this.log,
      (token, line) => this.onLine?.(token, line),
    );
    const id = String(this.nextChild++);
    this.children.set(id, child);
    child.rpc.closed.then(() => this.children.delete(id));
    return { id, info: child.info };
  }

  async sshClose(id: string) {
    const c = this.children.get(id);
    if (!c) return false;
    this.children.delete(id);
    await c.close();
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.children.keys()].map((id) => this.sshClose(id)));
  }
}

export function b64(s: string): string {
  return encodeBase64(new TextEncoder().encode(s));
}

/** The last non-empty line of some output, after any carriage-return redraws, without colour. */
export function lastLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].split("\r").filter((x) => x.trim()).at(-1) ?? "";
    // deno-lint-ignore no-control-regex
    const clean = l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
    if (clean) return clean;
  }
  return "";
}
