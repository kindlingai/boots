// What the engine uses to talk to the user. Everything goes through the
// frontend in use (frontend.ts): the line REPL by default, or the full-screen
// TUI. Nothing in the engine writes to the terminal itself.

import { emit, frontend, Interrupted, setDefaultFrontend, type Style } from "./frontend.ts";
import { LineFrontend } from "./frontends/line.ts";

export { Interrupted };

setDefaultFrontend(() => new LineFrontend());

const color = Deno.stdout.isTerminal() && !Deno.env.get("NO_COLOR");
const sgr = (n: string) => (s: string) => color ? `\x1b[${n}m${s}\x1b[0m` : s;
export const dim = sgr("2");
export const bold = sgr("1");
export const red = sgr("31");
export const green = sgr("32");
export const yellow = sgr("33");
export const cyan = sgr("36");

/** A transcript line. */
export function say(text: string, style?: Style): void {
  emit({ type: "line", text, style });
}

export function info(s: string): void {
  emit({ type: "line", text: s, style: "info" });
}

export function warn(s: string): void {
  emit({ type: "line", text: s, style: "warn" });
}

export interface Spinner {
  /** A new label for the same task, e.g. its latest output line. */
  update(label: string): void;
  stop(): void;
}

/** "⠋ thinking..." while something runs; stop() ends it. */
export function spinner(label: string): Spinner {
  emit({ type: "busy", label });
  let live = true;
  return {
    update(l: string) {
      if (live) emit({ type: "busy", label: l, same: true });
    },
    stop() {
      if (!live) return;
      live = false;
      emit({ type: "busy", label: null });
    },
  };
}

export async function ask(prompt: string): Promise<string | null> {
  return await frontend().readLine(prompt);
}

export async function askSecret(prompt: string): Promise<string | null> {
  return await frontend().readLine(prompt, true);
}

export async function confirm(prompt: string, def = true): Promise<boolean> {
  const a = await frontend().readLine(`${prompt} ${def ? "[Y/n]" : "[y/N]"} `);
  if (a === null) return false;
  const t = a.trim().toLowerCase();
  if (t === "") return def;
  return t === "y" || t === "yes";
}

/** Numbered menu. Returns the chosen index, or -1 on EOF. */
export async function choose(prompt: string, options: string[], def = 0): Promise<number> {
  say(prompt, "bold");
  options.forEach((o, i) => say(`  ${i + 1}) ${o}`));
  while (true) {
    const a = await frontend().readLine(`choice [${def + 1}]: `);
    if (a === null) return -1;
    if (a.trim() === "") return def;
    const n = parseInt(a.trim(), 10);
    if (n >= 1 && n <= options.length) return n - 1;
  }
}

export type Approval = { ok: boolean; always?: boolean; readonly?: boolean; note?: string };

/**
 * "readonly" offers r (allow every read-only command); "dangerous" and
 * "root" (anything run with sudo) offer no always: they ask every time.
 */
export type ApprovalKind = "normal" | "readonly" | "dangerous" | "root";

/**
 * y / n / s(omething else: tell the model), plus a(lways allow this one) or,
 * for a read-only command, r (allow every read-only command this session).
 */
export async function approve(what: string, kind: ApprovalKind = "normal"): Promise<Approval> {
  say(`${yellow("?")} ${what}`);
  // Wide gaps between the choices, so they read as separate items.
  const choices =
    (kind === "readonly"
      ? ["[y]es", "[n]o", "always allow [r]ead-only", "[s]omething else, I'll explain"]
      : kind === "dangerous" || kind === "root"
      ? ["[y]es", "[n]o", "[s]omething else, I'll explain"]
      : ["[y]es", "[n]o", "[a]lways", "[s]omething else, I'll explain"]).join("   ");
  while (true) {
    const a = await frontend().readLine(dim(`  run it? ${choices}: `));
    if (a === null) return { ok: false, note: "no input available" };
    const t = a.trim().toLowerCase();
    if (t === "y" || t === "yes") return { ok: true };
    if (t === "n" || t === "no" || t === "") return { ok: false };
    if (kind === "readonly" && t === "r") return { ok: true, readonly: true };
    if (kind === "normal" && t === "a") return { ok: true, always: true };
    if (t === "s") {
      const note = await frontend().readLine("  tell the model: ");
      return { ok: false, note: note ?? "" };
    }
  }
}

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

/** Text without color codes. */
export function plain(s: string): string {
  return s.replace(ANSI, "");
}
