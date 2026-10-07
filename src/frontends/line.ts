// The line frontend: a classic REPL on stdout. Spinners and progress bars
// share one "live" line at the bottom, redrawn in place and cleared before
// anything else prints. Without a terminal it prints plain lines instead.

import {
  busyText,
  doubleEsc,
  type EngineEvent,
  EscInterrupted,
  type Frontend,
  Interrupted,
  interruptNow,
  progressText,
  type Style,
} from "../frontend.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const color = Deno.stdout.isTerminal() && !Deno.env.get("NO_COLOR");
const sgr = (n: string) => (s: string) => color ? `\x1b[${n}m${s}\x1b[0m` : s;
const dim = sgr("2");
const cyan = sgr("36");
const STYLE: Record<Style, (s: string) => string> = {
  plain: (s) => s,
  dim,
  info: dim,
  warn: sgr("33"),
  error: sgr("31"),
  ok: sgr("32"),
  bold: sgr("1"),
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function write(s: string): void {
  Deno.stdout.writeSync(enc.encode(s));
}

type Progress = Extract<EngineEvent, { type: "progress" }>;

export class LineFrontend implements Frontend {
  private input = new Input();
  private tty = Deno.stdout.isTerminal();
  private shown = false;
  private busy: { label: string; t0: number; note?: string } | null = null;
  private progress = new Map<string, Progress>();
  private lastPrinted = new Map<string, number>();
  private streaming = false;
  private reading = false;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  emit(e: EngineEvent): void {
    switch (e.type) {
      case "line": {
        const text = STYLE[e.style ?? "plain"](e.text);
        this.print(text, e.style === "info" || e.style === "warn");
        break;
      }
      case "assistant":
        if (e.phase === "start") {
          this.clearLive();
          this.streaming = true;
          write(cyan("● "));
        } else if (e.phase === "delta") write(e.text ?? "");
        else {
          write("\n");
          this.streaming = false;
          this.drawLive();
        }
        break;
      case "busy":
        // A new label for the same task (its latest output) keeps the clock.
        this.busy = e.label
          ? { label: e.label, t0: e.same && this.busy ? this.busy.t0 : Date.now(), note: e.note }
          : null;
        if (this.busy) this.input.watch();
        else this.input.unwatch();
        this.tick();
        break;
      case "progress":
        this.progress.set(e.id, e);
        if (!this.tty) {
          // Without a terminal, a line now and then.
          const last = this.lastPrinted.get(e.id) ?? 0;
          if (Date.now() - last > 15_000) {
            this.lastPrinted.set(e.id, Date.now());
            console.error(dim(`  ${e.label}: ${progressText(e)}`));
          }
        }
        this.tick();
        break;
      case "progress-end":
        this.progress.delete(e.id);
        this.lastPrinted.delete(e.id);
        if (e.text) this.print(STYLE[e.ok ? "dim" : "warn"](e.text), true);
        else this.tick();
        break;
      case "activity":
        if (e.text) this.print(STYLE.dim(`  ▸ ${e.text}`), true);
        break;
      case "goals":
        // No status area here: a line when the active goals change.
        if (e.titles.length) this.print(STYLE.dim(`◆ ${e.titles.slice(0, 2).join(" · ")}`), true);
        break;
      case "status":
        break;
    }
  }

  async readLine(prompt: string, hidden = false): Promise<string | null> {
    this.clearLive();
    this.input.unwatch();
    this.reading = true;
    try {
      return await this.input.readLine(prompt, hidden);
    } finally {
      this.reading = false;
      this.tick();
    }
  }

  close(): void {
    this.clearLive();
    clearInterval(this.timer);
  }

  private print(s: string, err = false): void {
    this.clearLive();
    if (err) console.error(s);
    else console.log(s);
    this.drawLive();
  }

  private liveText(): string | null {
    const f = cyan(FRAMES[this.frame % FRAMES.length]);
    const p = [...this.progress.values()].at(-1);
    if (p) return `${f} ${p.label}  ${dim(progressText(p))}`;
    if (this.busy) {
      return `${f} ${dim(busyText(this.busy))}`;
    }
    return null;
  }

  /** Keeps the animation timer running only while there is something live. */
  private tick(): void {
    const live = this.tty && (this.busy || this.progress.size);
    if (live && this.timer === undefined) {
      this.timer = setInterval(() => {
        this.frame++;
        this.drawLive();
      }, 100);
    } else if (!live && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (live) this.drawLive();
    else this.clearLive();
  }

  private drawLive(): void {
    if (!this.tty || this.streaming || this.reading) return;
    const t = this.liveText();
    if (!t) return this.clearLive();
    const cols = (() => {
      try {
        return Deno.consoleSize().columns;
      } catch {
        return 100;
      }
    })();
    // Never wrap: a wrapped live line cannot be redrawn in place.
    write(`\r${truncate(t, cols - 1)}\x1b[K`);
    this.shown = true;
  }

  private clearLive(): void {
    if (this.tty && this.shown) write("\r\x1b[K");
    this.shown = false;
  }
}

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const SPLIT = new RegExp("(" + String.fromCharCode(27) + "\\[[0-9;]*m)");

/** Cuts a coloured string to `n` visible characters. */
function truncate(s: string, n: number): string {
  if (s.replace(ANSI, "").length <= n) return s;
  let out = "";
  let seen = 0;
  for (const part of s.split(SPLIT)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      continue;
    }
    const room = n - seen;
    if (room <= 0) continue;
    out += part.slice(0, room);
    seen += Math.min(part.length, room);
  }
  return out + "\x1b[0m";
}

/** One reader owns stdin for the whole process. */
class Input {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private buf: number[] = [];
  private eof = false;
  private lock: Promise<void> = Promise.resolve();
  private esc = doubleEsc();
  private watching = false;
  private prompting = false;

  /**
   * While something runs (no prompt open), read keys in raw mode so ^C and
   * Esc Esc reach us as keys. Anything else typed is kept for the next prompt.
   */
  watch(): void {
    if (this.watching || this.prompting || !Deno.stdin.isTerminal()) return;
    this.watching = true;
    try {
      Deno.stdin.setRaw(true);
    } catch {
      this.watching = false;
      return;
    }
    (async () => {
      while (this.watching && !this.eof) {
        await this.fill();
        // A prompt opened while we waited: what arrived is the prompt's.
        if (!this.watching) break;
        // ^C and a lone Esc are ours; anything else typed waits for the prompt.
        const got = this.buf.splice(0);
        const kept: number[] = [];
        for (const b of got) {
          if (b === 3) interruptNow("ctrl-c");
          else if (b === 27 && got.length === 1) {
            if (this.esc()) interruptNow("esc");
          } else kept.push(b);
        }
        this.buf.unshift(...kept);
      }
    })().catch(() => {});
  }

  unwatch(): void {
    if (!this.watching) return;
    this.watching = false;
    if (!this.prompting) {
      try {
        Deno.stdin.setRaw(false);
      } catch {
        // gone
      }
    }
  }

  /** The one read in flight: the key watcher and a prompt share it. */
  private inflight: Promise<void> | null = null;

  private fill(): Promise<void> {
    this.reader ??= Deno.stdin.readable.getReader();
    this.inflight ??= this.reader.read().then(({ value, done }) => {
      if (done || !value) this.eof = true;
      else this.buf.push(...value);
    }).finally(() => this.inflight = null);
    return this.inflight;
  }

  private async byte(): Promise<number | null> {
    while (!this.buf.length && !this.eof) await this.fill();
    return this.buf.length ? this.buf.shift()! : null;
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
      this.prompting = true;
      try {
        return await this.rawLine(hidden);
      } finally {
        this.prompting = false;
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
        // A lone Esc: twice in 2 s is ^C. Otherwise swallow escape
        // sequences (arrows etc.).
        if (!this.buf.length) {
          if (this.esc()) {
            write("Esc Esc\r\n");
            throw new EscInterrupted();
          }
          continue;
        }
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
