// A second opinion on commands the read-only list does not cover: the
// bootstrap model (usually the local Qwen) sorts each one into readonly,
// writes, dangerous or complex. Commands it calls complex go back to the
// model that wrote them, to be split into smaller steps.

import { chat, type Endpoint } from "./llm.ts";
import { stages } from "./readonly.ts";

export type Verdict = "readonly" | "writes" | "dangerous" | "complex";

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

export class Classifier {
  private cache = new Map<string, Verdict>();

  constructor(private model: () => Endpoint) {}

  /** null when the checker is off or did not answer: treat the command as one that writes. */
  async classify(cmd: string, os: string): Promise<Verdict | null> {
    if (Deno.env.get("AIBOOT_CHECK") === "0") return null;
    if (cmd.length > MAX_LEN) return "complex";
    const key = `${os}\0${cmd}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    try {
      const r = await chat(
        this.model(),
        [
          { role: "system", content: CLASSIFY_PROMPT },
          { role: "user", content: `Operating system: ${os}\nCommand:\n\`\`\`\n${cmd}\n\`\`\`` },
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
