// A second opinion on commands the read-only list does not cover: the
// bootstrap model (usually the local Qwen) sorts each one into readonly,
// writes, dangerous or complex. Commands it calls complex go back to the
// model that wrote them, to be split into smaller steps.

import { chat, type Endpoint } from "./llm.ts";
import { stageReadonly, stages } from "./readonly.ts";

/**
 * "unknown": it runs a script file (python3 check.py, ./setup.sh), whose
 * contents the check cannot see: the user decides, as with any command.
 */
export type Verdict = "readonly" | "writes" | "dangerous" | "complex" | "unknown";

/**
 * Programs that are never read-only when they run, whatever the model says.
 * Only the program of each pipeline stage counts, not its arguments (so
 * `ps aux | grep ollama` is not overruled for mentioning ollama).
 */
const WRITE_PROGRAMS = new Set(
  `rm rmdir mv cp dd mkfs mount umount chmod chown chgrp kill pkill killall reboot shutdown halt
  poweroff systemctl service apt apt-get yum dnf pacman brew pip pip3 uv npm tee truncate shred
  install ln touch mkdir wget ssh scp rsync sudo su doas crontab useradd usermod passwd chpasswd
  eval exec source . xargs nohup python python3 perl ruby node npx deno bash sh zsh fish osascript
  docker podman kubectl helm git make cmake cargo go conda ollama hf huggingface-cli lms vllm
  llama-server open start launchctl defaults networksetup iptables nft ufw firewall-cmd`.split(
    /\s+/,
  ),
);

/** curl options that write a file, send data, or change the method. */
const CURL_WRITES =
  /(^|\s)(-[a-zA-Z]*[oOTFdXKC]|--(data\S*|form\S*|upload\S*|output\S*|remote-name\S*|config|request|json|continue-at))(\s|=|$)/;

/** True when a stage the model called read-only would in fact write. */
function writingStage(toks: string[]): boolean {
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  if (i >= toks.length) return false;
  const head = toks[i].split(/[\\/]/).pop()!.replace(/\.exe$/i, "");
  const rest = toks.slice(i + 1).join(" ");
  if (WRITE_PROGRAMS.has(head) || /^mkfs/.test(head)) return true;
  if (head === "sed" && /(^|\s)(-[a-zA-Z]*i|--in-place)/.test(rest)) return true;
  if (head === "curl" && CURL_WRITES.test(rest)) return true;
  if (head === "find" && /-exec|-ok|-delete|-fprint|-fls/.test(rest)) return true;
  if (/^g?awk$/.test(head) && /system\s*\(|print[^;]*>|\|\s*"/.test(rest)) return true;
  return false;
}

const SHELL_KEYWORDS = new Set(
  "if then else elif fi for while until do done case esac select function { } [[ ]] ! time".split(
    " ",
  ),
);

/** More stages than this in one line: ask for smaller steps. */
const MAX_STAGES = 8;

/** Too long to be worth asking about. */
const MAX_LEN = 600;

export const CLASSIFY_PROMPT = `You check shell commands before they run on a user's machine.
Classify the command. Answer with exactly one word:

readonly - only reads or inspects: it prints information and changes no files, settings, packages,
services or processes. Querying a local server (curl -s http://localhost:8000/v1/models), printing
versions, status, logs, listings, hardware and config files are all readonly, even with options,
pipes into grep/head/sort/jq, or 2>/dev/null.
writes - creates, edits, moves or deletes files; installs or removes software; starts, stops or
restarts services or processes; changes settings; uploads or posts data.
dangerous - could destroy data, break the system, lock the user out, or is hard to undo: rm -rf,
dd, mkfs, partitioning, chmod or chown -R on system paths, killing system processes, firewall or
network changes, piping a download into a shell, reboot.
complex - too long or intricate to judge: long command lists, loops, inline scripts (python -c,
bash -c, awk programs), eval, here-documents, nested substitutions.

Examples:
nvidia-smi --query-gpu=name,memory.used --format=csv -> readonly
ls -la ~/models | grep -i gguf -> readonly
ps aux | grep -v grep | grep ollama -> readonly
curl -s http://127.0.0.1:8080/health -> readonly
cat /etc/os-release; uname -m -> readonly
lsof -i :8000 -> readonly
journalctl -u ollama --no-pager -n 50 -> readonly
ollama pull qwen3:8b -> writes
mkdir -p ~/models && cd ~/models -> writes
systemctl restart ollama -> writes
curl -fsSL https://ollama.com/install.sh | sh -> dangerous
for f in *.gguf; do du -h "$f"; done -> complex

Judge what the command does, not the names it mentions: grep ollama only reads. Answer writes only
when the command itself would change something.`;

/** The first verdict word in a reply. */
export function parseVerdict(reply: string): Verdict | null {
  const m = reply.toLowerCase().match(/\b(readonly|read-only|writes|dangerous|complex)\b/);
  if (!m) return null;
  return m[1] === "read-only" ? "readonly" : m[1] as Verdict;
}

/** Applies the hard rules to a model's verdict. */
export function guard(cmd: string, v: Verdict): Verdict {
  if (cmd.length > MAX_LEN) return "complex";
  if (v !== "readonly") return v;
  // Substitution, a here-document or a redirect into a file: more than it says.
  const st = stages(cmd);
  if (!st) return "writes";
  return st.some(writingStage) ? "writes" : "readonly";
}

/** How bad each verdict is: a command is as bad as its worst stage. */
const RANK: Record<Verdict, number> = {
  readonly: 0,
  writes: 1,
  unknown: 2,
  complex: 3,
  dangerous: 4,
};

/** Interpreters that run a program from a file. */
const INTERPRETERS =
  /^(python[\d.]*|pypy3?|bash|sh|zsh|dash|ksh|fish|node|nodejs|deno|bun|perl|ruby|php|lua|Rscript|pwsh|powershell)$/;

/**
 * True when a stage runs a script file or a program by path: what it does
 * is in the file, not the command line (inline code, -c/-e, is left to the
 * model, which calls long inline scripts complex).
 */
export function runsScript(toks: string[]): boolean {
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  const first = toks[i] ?? "";
  const head = first.split(/[\\/]/).pop()!;
  if (INTERPRETERS.test(head)) {
    // python3 x.py, bash setup.sh, deno run x.ts, python3 -m pkg; not -c/-e code.
    const rest = toks.slice(i + 1);
    if (rest.some((t) => /^-(c|e|-eval|-command)$/.test(t))) return false;
    if (rest.includes("-m")) return true;
    return rest.some((t) => !t.startsWith("-") && t !== "run");
  }
  // ./setup.sh, ~/bin/tool, /opt/x/run: a program by path that is not a
  // known command (/usr/bin/ls is ls).
  return /^(\.{1,2}\/|~\/|\/(home|tmp|opt|root|srv|var|Users|private|mnt|data)\/)/.test(first);
}

/** A word as the shell would need it written (for showing a stage on its own). */
export function shellQuote(w: string): string {
  return /^[A-Za-z0-9_\-.\/:=@%+,~^]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

/** Programs that run whatever they are fed. */
const RUNS_INPUT =
  /^(sh|bash|zsh|dash|ksh|fish|python3?|perl|ruby|node|deno|php|powershell|pwsh|iex|source|\.)$/;

/** A download piped into something that runs it: `curl … | sh`. */
export function pipesDownloadIntoShell(st: string[][]): boolean {
  const head = (t: string[]) => {
    let i = 0;
    while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
    while (i < t.length && /^(sudo|env|exec|nohup|command|time)$/.test(t[i])) i++;
    return (t[i] ?? "").split(/[\\/]/).pop()!;
  };
  const fetched = st.findIndex((t) => /^(curl|wget|iwr|Invoke-WebRequest|fetch)$/.test(head(t)));
  return fetched >= 0 && st.slice(fetched + 1).some((t) => RUNS_INPUT.test(head(t)));
}

export class Classifier {
  private cache = new Map<string, Verdict>();
  private culprits = new Map<string, string>();

  constructor(private model: () => Endpoint) {}

  /**
   * null when the checker is off or did not answer: treat the command as one
   * that writes. A command line of several stages (pipes, ;, &&, ||) is split
   * and judged stage by stage: stages on the read-only list need no model,
   * the rest are asked about one at a time, and the line is as bad as its
   * worst stage. A line that cannot be split safely (substitution, a
   * here-document, a redirect into a file) is asked about whole.
   */
  async classify(cmd: string, os: string, root = false): Promise<Verdict | null> {
    if (Deno.env.get("AIBOOT_CHECK") === "0") return null;
    this.culprits.delete(cmd);
    const st = stages(cmd);
    // Loops and conditionals do not split into independent stages.
    if (st && st.length === 1 && runsScript(st[0])) return "unknown";
    if (!st || st.length < 2 || st.some((t) => SHELL_KEYWORDS.has(t[0]))) {
      if (cmd.length > MAX_LEN) return "complex";
      return await this.ask(cmd, os, null, root);
    }
    if (pipesDownloadIntoShell(st)) return "dangerous";
    if (st.length > MAX_STAGES || cmd.length > MAX_LEN * 3) return "complex";
    let worst: Verdict = "readonly";
    let culprit = "";
    for (const toks of st) {
      if (stageReadonly([...toks])) continue;
      const seg = toks.map(shellQuote).join(" ");
      if (runsScript(toks)) {
        if (RANK.unknown > RANK[worst]) [worst, culprit] = ["unknown", seg];
        continue;
      }
      if (seg.length > MAX_LEN) return "complex";
      const v = await this.ask(seg, os, cmd, root);
      if (v === null) return null;
      if (RANK[v] > RANK[worst]) [worst, culprit] = [v, seg];
      if (worst === "dangerous") break;
    }
    if (culprit) this.culprits.set(cmd, culprit);
    return worst;
  }

  /**
   * The stage that decided the verdict of a command line judged stage by
   * stage (the first one as bad as the whole line); undefined when the line
   * was judged whole or every stage was read-only.
   */
  culprit(cmd: string): string | undefined {
    return this.culprits.get(cmd);
  }

  /** One question to the model, about `cmd` (a stage of `whole`, when given). */
  private async ask(
    cmd: string,
    os: string,
    whole: string | null,
    root = false,
  ): Promise<Verdict | null> {
    const key = `${os}\0${root ? "root\0" : ""}${cmd}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const context = whole
      ? `\nIt is one stage of this command line (judge only the stage; the other stages are checked separately):\n\`\`\`\n${whole}\n\`\`\``
      : "";
    try {
      const r = await chat(
        this.model(),
        [
          { role: "system", content: CLASSIFY_PROMPT },
          {
            role: "user",
            content: `Operating system: ${os}\n${
              root
                ? "It runs as root (with sudo): judge it as root. Changes to system files, services, users, permissions or disks are writes, and anything that could break the system or lock the user out is dangerous.\n"
                : ""
            }Command:\n\`\`\`\n${cmd}\n\`\`\`${context}`,
          },
        ],
        [],
        {},
        AbortSignal.timeout(30_000),
        0,
      );
      const v = parseVerdict(r.content);
      if (!v) return null;
      const g = guard(cmd, v);
      this.cache.set(key, g);
      return g;
    } catch {
      return null;
    }
  }
}
