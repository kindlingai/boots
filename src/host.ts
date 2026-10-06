// What one machine can do: run commands, read and write files, sudo, and
// open an ssh hop to the next machine. The near side and every far agent
// run the same Host; requests addressed `via` a child hop are forwarded.

import { dirname, isAbsolute, join } from "@std/path";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import type { Asker } from "./secrets.ts";
import { currentTarget, isWindows, modelsDir, scriptsDir, VERSION } from "./platform.ts";
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
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  cwd?: string;
}

const CWD_MARK = "\x1eAIBOOT-CWD ";
const SUDO_REJECTED =
  /incorrect password|sorry, try again|no password was provided|password is required/i;

export class Host {
  cwd = Deno.cwd();
  private children = new Map<string, SshChild>();
  private nextChild = 1;
  private shellPath: string | null = null;
  private osNameCache: string | null = null;

  constructor(private ask: Asker, private log: (s: string) => void = () => {}) {}

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
        return await this.exec(String(args.cmd), args.timeoutMs);
      case "sudo":
        return await this.sudo(String(args.cmd), args.timeoutMs);
      case "read":
        return await this.read(String(args.path), args.maxBytes);
      case "write":
        return await this.write(String(args.path), String(args.b64 ?? ""), args.mode);
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

  private async spawn(argv: string[], opts: { stdin?: string; timeoutMs?: number; cwd?: string }) {
    const ac = new AbortController();
    const ms = opts.timeoutMs ?? 10 * 60_000;
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, ms);
    try {
      const p = new Deno.Command(argv[0], {
        args: argv.slice(1),
        cwd: opts.cwd ?? this.cwd,
        stdin: opts.stdin !== undefined ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
        signal: ac.signal,
      }).spawn();
      if (opts.stdin !== undefined) {
        const w = p.stdin.getWriter();
        await w.write(new TextEncoder().encode(opts.stdin)).catch(() => {});
        await w.close().catch(() => {});
      }
      const out = await p.output();
      const dec = new TextDecoder();
      return {
        code: out.code,
        stdout: dec.decode(out.stdout),
        stderr: dec.decode(out.stderr),
        timedOut,
      };
    } catch (e) {
      return { code: 127, stdout: "", stderr: (e as Error).message, timedOut };
    } finally {
      clearTimeout(t);
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
    if (r.timedOut) r.stderr += "\n(timed out)";
    return r;
  }

  private shellArgv(sh: string, script: string): string[] {
    return isWindows
      ? ["powershell", "-NoProfile", "-NonInteractive", "-Command", script]
      : [sh, "-c", script];
  }

  async exec(cmd: string, timeoutMs?: number): Promise<ExecResult> {
    const sh = await this.shell();
    return this.finish(await this.spawn(this.shellArgv(sh, this.wrap(cmd)), { timeoutMs }));
  }

  /** Runs as root, asking up the hop chain for a password only if sudo wants one. */
  async sudo(cmd: string, timeoutMs?: number): Promise<ExecResult> {
    if (isWindows) return { code: 1, stdout: "", stderr: "sudo is not available on Windows hosts" };
    const sh = await this.shell();
    const script = this.wrap(cmd);
    const quick = await this.spawn(["sudo", "-n", "true"], { timeoutMs: 15_000 });
    if (quick.code === 0) {
      return this.finish(await this.spawn(["sudo", "-n", sh, "-c", script], { timeoutMs }));
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

  async write(path: string, b64: string, mode?: string) {
    const full = this.resolve(path);
    await Deno.mkdir(dirname(full), { recursive: true });
    const bytes = decodeBase64(b64);
    await Deno.writeFile(full, bytes);
    if (mode && !isWindows) await Deno.chmod(full, parseInt(mode, 8));
    return { path: full, bytes: bytes.length };
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
    const child = await openSsh(dest, port ? String(port) : undefined, childAsk, this.log);
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
