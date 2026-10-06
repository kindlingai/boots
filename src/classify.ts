// A second opinion on commands the read-only list does not cover: the
// bootstrap model (usually the local Qwen) sorts each one into readonly,
// writes, dangerous or complex. Commands it calls complex go back to the
// model that wrote them, to be split into smaller steps.

import { chat, type Endpoint } from "./llm.ts";

export type Verdict = "readonly" | "writes" | "dangerous" | "complex";

/** Never read-only, whatever the model says. */
const WRITES =
  /(^|[\s;|&(])(rm|rmdir|mv|cp|dd|mkfs\S*|mount|umount|chmod|chown|chgrp|kill|pkill|killall|reboot|shutdown|halt|poweroff|systemctl|service|apt|apt-get|yum|dnf|pacman|brew|pip3?|uv|npm|tee|truncate|shred|install|ln|touch|mkdir|wget|ssh|scp|rsync|sudo|su|doas|crontab|useradd|usermod|passwd|chpasswd|eval|exec|source|xargs|nohup|python3?|perl|ruby|node|npx|deno|bash|sh|zsh|osascript|docker|podman|kubectl|helm|git|make|cmake|cargo|go|conda|ollama|hf|huggingface-cli|lms|vllm|llama-server|open|start|launchctl|defaults|networksetup|iptables|nft|ufw|firewall-cmd)(\s|$)|\$\(|`|sed\s+(-\S*i|--in-place)|>(?!\s*\/dev\/null|&)|curl\s.*(\s-[a-zA-Z]*[oOTFdXK]|--(data|form|upload|output|remote-name|config|request))/;

/** Too long to be worth asking about. */
const MAX_LEN = 600;

export const CLASSIFY_PROMPT = `You check shell commands before they run on a user's machine.
Classify the command. Answer with exactly one word:

readonly - definitely only reads or inspects: it changes no files, settings, packages, services or processes, and sends nothing anywhere.
writes - changes something, or might.
dangerous - could destroy data, break the system, lock the user out, or is hard to undo: rm -rf, dd, mkfs, partitioning, chmod or chown -R on system paths, killing system processes, firewall or network changes, piping a download into a shell, reboot.
complex - too long or intricate to judge with confidence: long pipelines or command lists, loops, inline scripts (python -c, bash -c, awk programs), eval, here-documents, nested substitutions.

If unsure between readonly and writes, answer writes.`;

/** The first verdict word in a reply. */
export function parseVerdict(reply: string): Verdict | null {
  const m = reply.toLowerCase().match(/\b(readonly|read-only|writes|dangerous|complex)\b/);
  if (!m) return null;
  return m[1] === "read-only" ? "readonly" : m[1] as Verdict;
}

/** Applies the hard rules to a model's verdict. */
export function guard(cmd: string, v: Verdict): Verdict {
  if (cmd.length > MAX_LEN) return "complex";
  if (v === "readonly" && WRITES.test(cmd)) return "writes";
  return v;
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
