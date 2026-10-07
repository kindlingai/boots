// What the engine uses to talk to the user. Everything goes through the
// frontend in use (frontend.ts): the line REPL by default, or the full-screen
// TUI. Nothing in the engine writes to the terminal itself.

import {
  type Choice,
  emit,
  frontend,
  Interrupted,
  setDefaultFrontend,
  type Style,
} from "./frontend.ts";
import { LineFrontend } from "./frontends/line.ts";

export { Interrupted };

setDefaultFrontend(() => new LineFrontend());

let color = Deno.stdout.isTerminal() && !Deno.env.get("NO_COLOR");
/** Colour on or off (the GUI turns it on: it draws the colours itself). */
export function setColor(on: boolean): void {
  color = on && !Deno.env.get("NO_COLOR");
}
const sgr = (n: string) => (s: string) => color ? `\x1b[${n}m${s}\x1b[0m` : s;
export const dim = sgr("2");
export const bold = sgr("1");
export const red = sgr("31");
export const green = sgr("32");
export const yellow = sgr("33");
export const cyan = sgr("36");
export const magenta = sgr("35");
export const blue = sgr("34");

/**
 * How a command is shown: where it runs, then a prompt sign, then the
 * command, each in its own colour. "$" for a command, "#" for one run as
 * root (sudo), ">>" for an ssh hop to another machine.
 */
export function commandLine(where: string, sign: "$" | "#" | ">>", cmd: string): string {
  const mark = sign === "#" ? red(sign) : sign === ">>" ? magenta(sign) : yellow(sign);
  return `${cyan(where)} ${bold(mark)} ${cmd}`;
}

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
  /** A note after the time, e.g. a token count. */
  note(text: string): void;
  stop(): void;
}

/** "⠋ thinking..." while something runs; stop() ends it. */
export function spinner(label: string): Spinner {
  emit({ type: "busy", label });
  let live = true;
  return {
    update(l: string) {
      if (!live) return;
      label = l;
      emit({ type: "busy", label, same: true });
    },
    note(n: string) {
      if (live) emit({ type: "busy", label, same: true, note: n });
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
  const a = await frontend().readLine(`${prompt} ${def ? "[Y/n]" : "[y/N]"} `, false, [
    { key: "y", label: "Yes" },
    { key: "n", label: "No" },
  ]);
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
  say(what);
  const offered: Choice[] = [
    { key: "y", label: "Yes" },
    { key: "n", label: "No" },
    ...(kind === "readonly"
      ? [{ key: "r", label: "Always allow read-only" }]
      : kind === "normal"
      ? [{ key: "a", label: "Always" }]
      : []),
    { key: "s", label: "Something else, I'll explain" },
  ];
  // As text: the key in brackets inside its label, with wide gaps between.
  const text = offered.map((c) => {
    const i = c.label.toLowerCase().indexOf(c.key);
    return i < 0
      ? `[${c.key}] ${c.label}`
      : `${c.label.slice(0, i).toLowerCase()}[${c.key}]${c.label.slice(i + 1).toLowerCase()}`;
  }).join("   ").replace("i'll", "I'll");
  while (true) {
    const a = await frontend().readLine(dim(`  run it? ${text}: `), false, offered);
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
