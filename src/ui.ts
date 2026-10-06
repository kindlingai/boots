// Terminal input and output. One reader owns stdin for the whole process.

const enc = new TextEncoder();
const dec = new TextDecoder();

const color = Deno.stdout.isTerminal() && !Deno.env.get("NO_COLOR");
const sgr = (n: string) => (s: string) => color ? `\x1b[${n}m${s}\x1b[0m` : s;
export const dim = sgr("2");
export const bold = sgr("1");
export const red = sgr("31");
export const green = sgr("32");
export const yellow = sgr("33");
export const cyan = sgr("36");

export function write(s: string): void {
  Deno.stdout.writeSync(enc.encode(s));
}

export interface Spinner {
  stop(): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * "⠋ thinking..." on the current line, animated, with the seconds once it
 * takes a while; stop() clears the line. Nothing when stdout is not a terminal.
 */
export function spinner(label: string): Spinner {
  if (!Deno.stdout.isTerminal()) return { stop() {} };
  const t0 = Date.now();
  let i = 0;
  let live = true;
  const draw = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    write(
      `\r${cyan(FRAMES[i++ % FRAMES.length])} ${dim(`${label}...${s >= 3 ? ` ${s}s` : ""}`)}\x1b[K`,
    );
  };
  // Whatever else prints meanwhile (notices, tool output) starts on a clean line.
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => {
    write("\r\x1b[K");
    log(...a);
  };
  console.error = (...a: unknown[]) => {
    write("\r\x1b[K");
    error(...a);
  };
  draw();
  const timer = setInterval(draw, 100);
  return {
    stop() {
      if (!live) return;
      live = false;
      clearInterval(timer);
      console.log = log;
      console.error = error;
      write("\r\x1b[K");
    },
  };
}

export function info(s: string): void {
  console.error(dim(s));
}

export function warn(s: string): void {
  console.error(yellow(s));
}

export class Interrupted extends Error {
  constructor() {
    super("interrupted");
  }
}

class Input {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private buf: number[] = [];
  private eof = false;
  private lock: Promise<void> = Promise.resolve();

  private async byte(): Promise<number | null> {
    if (this.buf.length) return this.buf.shift()!;
    if (this.eof) return null;
    this.reader ??= Deno.stdin.readable.getReader();
    const { value, done } = await this.reader.read();
    if (done || !value) {
      this.eof = true;
      return null;
    }
    this.buf.push(...value);
    return this.buf.shift()!;
  }

  /** Reads one line. Returns null at EOF. Ctrl-C throws Interrupted. */
  readLine(prompt: string, hidden = false): Promise<string | null> {
    const run = async () => {
      const tty = Deno.stdin.isTerminal();
      write(prompt);
      if (!tty) {
        const l = await this.cookedLine();
        // Piped input is not echoed; end the prompt line ourselves.
        if (!Deno.stdout.isTerminal()) write(hidden ? "***\n" : `${l ?? ""}\n`);
        return l;
      }
      Deno.stdin.setRaw(true);
      try {
        return await this.rawLine(hidden);
      } finally {
        Deno.stdin.setRaw(false);
      }
    };
    // Serialize: an askpass prompt may arrive while another is pending.
    const p = this.lock.then(run);
    this.lock = p.then(() => {}, () => {});
    return p;
  }

  private async cookedLine(): Promise<string | null> {
    const out: number[] = [];
    while (true) {
      const b = await this.byte();
      if (b === null) return out.length ? dec.decode(new Uint8Array(out)) : null;
      if (b === 10) break;
      if (b !== 13) out.push(b);
    }
    return dec.decode(new Uint8Array(out));
  }

  private async rawLine(hidden: boolean): Promise<string | null> {
    let s = "";
    let pending: number[] = [];
    while (true) {
      const b = await this.byte();
      if (b === null) return s || null;
      if (b === 3) {
        write("^C\r\n");
        throw new Interrupted();
      }
      if (b === 4 && s === "") {
        write("\r\n");
        return null;
      }
      if (b === 13 || b === 10) {
        write("\r\n");
        return s;
      }
      if (b === 127 || b === 8) {
        if (s.length) {
          const chars = [...s];
          chars.pop();
          s = chars.join("");
          if (!hidden) write("\b \b");
        }
        continue;
      }
      if (b === 27) {
        // Swallow escape sequences (arrows etc.).
        const n = await this.byte();
        if (n === 91 || n === 79) {
          let c = await this.byte();
          while (c !== null && c < 64) c = await this.byte();
        }
        continue;
      }
      if (b < 32) continue;
      pending.push(b);
      const text = dec.decode(new Uint8Array(pending), { stream: true });
      if (text) {
        pending = [];
        s += text;
        if (!hidden) write(text);
      }
    }
  }
}

export const input = new Input();

export async function ask(prompt: string): Promise<string | null> {
  return await input.readLine(prompt);
}

export async function askSecret(prompt: string): Promise<string | null> {
  return await input.readLine(prompt, true);
}

export async function confirm(prompt: string, def = true): Promise<boolean> {
  const a = await input.readLine(`${prompt} ${def ? "[Y/n]" : "[y/N]"} `);
  if (a === null) return false;
  const t = a.trim().toLowerCase();
  if (t === "") return def;
  return t === "y" || t === "yes";
}

/** Numbered menu. Returns the chosen index, or -1 on EOF. */
export async function choose(prompt: string, options: string[], def = 0): Promise<number> {
  console.log(bold(prompt));
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  while (true) {
    const a = await input.readLine(`choice [${def + 1}]: `);
    if (a === null) return -1;
    if (a.trim() === "") return def;
    const n = parseInt(a.trim(), 10);
    if (n >= 1 && n <= options.length) return n - 1;
  }
}

export type Approval = { ok: boolean; always?: boolean; readonly?: boolean; note?: string };

/** "readonly" offers r (allow every read-only command); "dangerous" offers no always. */
export type ApprovalKind = "normal" | "readonly" | "dangerous";

/**
 * y / n / s(omething else: tell the model), plus a(lways allow this one) or,
 * for a read-only command, r (allow every read-only command this session).
 */
export async function approve(what: string, kind: ApprovalKind = "normal"): Promise<Approval> {
  console.log(`${yellow("?")} ${what}`);
  const choices = kind === "readonly"
    ? "[y]es [n]o always allow [r]ead-only [s]omething else, I'll explain"
    : kind === "dangerous"
    ? "[y]es [n]o [s]omething else, I'll explain"
    : "[y]es [n]o [a]lways [s]omething else, I'll explain";
  while (true) {
    const a = await input.readLine(dim(`  run it? ${choices}: `));
    if (a === null) return { ok: false, note: "no input available" };
    const t = a.trim().toLowerCase();
    if (t === "y" || t === "yes") return { ok: true };
    if (t === "n" || t === "no" || t === "") return { ok: false };
    if (kind === "readonly" && t === "r") return { ok: true, readonly: true };
    if (kind === "normal" && t === "a") return { ok: true, always: true };
    if (t === "s") {
      const note = await input.readLine("  tell the model: ");
      return { ok: false, note: note ?? "" };
    }
  }
}

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

/** Text without color codes. */
export function plain(s: string): string {
  return s.replace(ANSI, "");
}
