// The full-screen frontend (ai-bootstrap --tui): a little bot with a speech
// bubble at the top, the transcript in the middle, a status line for what is
// running (spinner or progress bar) and the input line at the bottom. It
// draws from engine events only, so the engine does not know it exists.
//
//    +-----+
//    | o o |      ╭──────────────────────────────╮
//    +-----+    ◀ │ the assistant's latest words │
//      | |        ╰──────────────────────────────╯
//     b   d

import {
  botName,
  doubleEsc,
  type EngineEvent,
  EscInterrupted,
  type Frontend,
  Interrupted,
  interruptNow,
  progressText,
  type Style,
} from "../frontend.ts";

import { bot, type Mood, moodOf, wrap } from "./bot.ts";
export { bot, wrap };

const enc = new TextEncoder();
const dec = new TextDecoder();
const ESC = "\x1b[";
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const c = (code: string) => (s: string) => `${ESC}${code}m${s}${ESC}0m`;
const COLOR = {
  dim: c("2"),
  bold: c("1"),
  cyan: c("36"),
  yellow: c("33"),
  red: c("31"),
  green: c("32"),
  magenta: c("35"),
  inverse: c("7"),
  grey: c("90"),
  white: c("97"),
  brightBlue: c("94"),
  sweat: c("96"),
};

/**
 * The bot in colour: a grey body with white eyes and bright blue boots. The
 * antenna is grey while it is a plain line, dark red when it signals (? * .).
 */
export function paintBot(art: string[]): string[] {
  const [antenna, top, face, mouth, legs, feet] = art;
  // Sweat drops sit in the outer columns of the head rows.
  const edges = (row: string, middle: (s: string) => string) => {
    const tint = (ch: string) => (ch === " " ? ch : COLOR.sweat(ch));
    return tint(row[0]) + middle(row.slice(1, -1)) + tint(row.at(-1)!);
  };
  const eyesAt = face.indexOf("|");
  const eyesEnd = face.lastIndexOf("|");
  return [
    antenna.trim() === "|" ? COLOR.grey(antenna) : COLOR.red(antenna),
    edges(top, COLOR.grey),
    edges(
      face,
      (m) =>
        COLOR.grey(m.slice(0, eyesAt)) + COLOR.white(m.slice(eyesAt, eyesEnd - 1)) +
        COLOR.grey(m.slice(eyesEnd - 1)),
    ),
    edges(mouth, COLOR.grey),
    COLOR.grey(legs),
    COLOR.brightBlue(feet),
  ];
}

type Kind = Style | "user" | "assistant";
interface Entry {
  kind: Kind;
  text: string;
}
type ProgressEv = Extract<EngineEvent, { type: "progress" }>;

interface Pending {
  prompt: string;
  hidden: boolean;
  resolve: (s: string | null) => void;
  reject: (e: Error) => void;
}

const plain = (s: string) => s.replace(ANSI, "");

const fit = (s: string, w: number) => {
  const chars = [...s];
  return chars.length > w
    ? chars.slice(0, Math.max(0, w - 1)).join("") + "…"
    : s + " ".repeat(w - chars.length);
};

export class TuiFrontend implements Frontend {
  private entries: Entry[] = [];
  private streaming: Entry | null = null;
  private speech = `Hi! I'm ${botName()}. I set up AI models on your machines.`;
  private busy: { label: string; t0: number } | null = null;
  private progress = new Map<string, ProgressEv>();
  private status: { model?: string; location?: string; full?: boolean } = {};
  private flash: { mood: Mood; until: number } | null = null;
  private talkedAt = 0;
  private scroll = 0;
  private frame = 0;
  private blinkUntil = 0;
  private pending: Pending | null = null;
  private queue: Pending[] = [];
  private buf = "";
  private cursor = 0;
  private history: string[] = [];
  private historyAt = -1;
  private dirty = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private restore = () => this.leave();
  private esc = doubleEsc();

  constructor(private opts: { title: string; onInterrupt: () => void }) {}

  start(): void {
    Deno.stdin.setRaw(true);
    this.out(`${ESC}?1049h${ESC}?25l${ESC}2J`);
    globalThis.addEventListener("unload", this.restore);
    try {
      Deno.addSignalListener("SIGWINCH", () => this.render());
    } catch {
      // not on this platform: sizes are read on every frame anyway
    }
    this.timer = setInterval(() => {
      this.frame++;
      if (Math.random() < 0.04) this.blinkUntil = Date.now() + 180;
      this.render();
    }, 160);
    this.keys();
    this.render();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.leave();
    globalThis.removeEventListener("unload", this.restore);
  }

  private leave(): void {
    try {
      this.out(`${ESC}0m${ESC}?25h${ESC}?1049l`);
      Deno.stdin.setRaw(false);
    } catch {
      // already gone
    }
  }

  // ---- engine events ----

  emit(e: EngineEvent): void {
    switch (e.type) {
      case "line": {
        for (const l of plain(e.text).split("\n")) this.push(e.style ?? "plain", l);
        if (e.style === "error") this.mood("sad", 4000);
        if (e.style === "ok") this.mood("happy", 3000);
        break;
      }
      case "assistant":
        if (e.phase === "start") {
          this.streaming = { kind: "assistant", text: "" };
          this.entries.push(this.streaming);
          this.speech = "";
        } else if (e.phase === "delta" && this.streaming) {
          this.streaming.text += e.text ?? "";
          this.speech = this.streaming.text;
        } else {
          this.streaming = null;
        }
        this.talkedAt = Date.now();
        this.scroll = 0;
        break;
      case "busy":
        // A new label for the same task (its latest output) keeps the clock.
        this.busy = e.label
          ? { label: e.label, t0: e.same && this.busy ? this.busy.t0 : Date.now() }
          : null;
        break;
      case "progress":
        this.progress.set(e.id, e);
        break;
      case "progress-end":
        this.progress.delete(e.id);
        if (e.text) this.push(e.ok ? "dim" : "warn", e.text);
        this.mood(e.ok ? "happy" : "sad", 2500);
        break;
      case "status": {
        const handedOver = e.full !== undefined && !!e.full !== !!this.status.full;
        this.status = { ...this.status, ...e };
        if (handedOver && !this.streaming) {
          this.speech = e.full
            ? `I'm ${botName(true)} now${e.model ? `, running on ${e.model}` : ""}.`
            : `Back to being ${botName()}, on the bootstrap model.`;
          this.mood(e.full ? "happy" : "sad", 2500);
        }
        break;
      }
    }
    this.schedule();
  }

  private push(kind: Kind, text: string): void {
    this.entries.push({ kind, text });
    if (this.entries.length > 2000) this.entries.splice(0, this.entries.length - 2000);
  }

  private mood(m: Mood, ms: number): void {
    this.flash = { mood: m, until: Date.now() + ms };
  }

  private currentMood(): Mood {
    return moodOf({
      flash: this.flash,
      streaming: !!this.streaming,
      talkedAt: this.talkedAt,
      progress: this.progress.size > 0,
      busy: this.busy?.label ?? null,
      prompt: this.pending?.prompt ?? null,
    });
  }

  // ---- input ----

  readLine(prompt: string, hidden = false): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const p: Pending = { prompt: plain(prompt), hidden, resolve, reject };
      if (this.pending) this.queue.push(p);
      else this.begin(p);
    });
  }

  private begin(p: Pending): void {
    this.pending = p;
    this.buf = "";
    this.cursor = 0;
    this.historyAt = -1;
    this.schedule();
  }

  private finish(value: string | null, error?: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (error) p.reject(error);
    else p.resolve(value);
    const next = this.queue.shift();
    if (next) this.begin(next);
    this.schedule();
  }

  private async keys(): Promise<void> {
    this.reader = Deno.stdin.readable.getReader();
    let carry: number[] = [];
    while (!this.closed) {
      const { value, done } = await this.reader.read().catch(() => ({
        value: undefined,
        done: true,
      }));
      if (done || !value) {
        this.finish(null);
        return;
      }
      const bytes = [...carry, ...value];
      carry = [];
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 27) {
          // ESC [ ... final byte, or ESC O x.
          let j = i + 1;
          if (bytes[j] === 91 || bytes[j] === 79) {
            j++;
            while (j < bytes.length && bytes[j] < 64) j++;
            if (j >= bytes.length) {
              carry = bytes.slice(i);
              break;
            }
            this.escape(dec.decode(new Uint8Array(bytes.slice(i + 2, j + 1))));
            i = j;
          } else if (j >= bytes.length && this.esc()) {
            // A lone Esc (not Alt+key, not a sequence): twice in 2 s stops
            // like ^C, but never quits.
            this.escEsc();
          }
          continue;
        }
        if (b === 3) this.ctrlC();
        else if (b === 4) {
          if (this.pending && !this.buf) this.finish(null);
        } else if (b === 13 || b === 10) this.enter();
        else if (b === 127 || b === 8) {
          this.edit(() => {
            if (this.cursor > 0) {
              const ch = [...this.buf];
              ch.splice(this.cursor - 1, 1);
              this.buf = ch.join("");
              this.cursor--;
            }
          });
        } else if (b === 21) {
          this.edit(() => {
            this.buf = "";
            this.cursor = 0;
          });
        } else if (b === 12) this.out(`${ESC}2J`);
        else if (b >= 32) {
          // Gather a whole UTF-8 character.
          let j = i + 1;
          while (j < bytes.length && (bytes[j] & 0xc0) === 0x80) j++;
          const ch = dec.decode(new Uint8Array(bytes.slice(i, j)));
          i = j - 1;
          this.edit(() => {
            const chars = [...this.buf];
            chars.splice(this.cursor, 0, ch);
            this.buf = chars.join("");
            this.cursor++;
          });
        }
      }
      this.schedule();
    }
  }

  private edit(f: () => void): void {
    if (this.pending) f();
  }

  private escape(seq: string): void {
    const n = [...this.buf].length;
    switch (seq) {
      case "D":
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case "C":
        this.cursor = Math.min(n, this.cursor + 1);
        break;
      case "H":
      case "1~":
        this.cursor = 0;
        break;
      case "F":
      case "4~":
        this.cursor = n;
        break;
      case "5~":
        this.scroll += this.bodyHeight() - 1;
        break;
      case "6~":
        this.scroll = Math.max(0, this.scroll - (this.bodyHeight() - 1));
        break;
      case "A":
        if (this.pending && !this.pending.hidden && this.history.length) {
          this.historyAt = Math.min(this.history.length - 1, this.historyAt + 1);
          this.buf = this.history[this.history.length - 1 - this.historyAt];
          this.cursor = [...this.buf].length;
        }
        break;
      case "B":
        if (this.pending && this.historyAt >= 0) {
          this.historyAt--;
          this.buf = this.historyAt < 0
            ? ""
            : this.history[this.history.length - 1 - this.historyAt];
          this.cursor = [...this.buf].length;
        }
        break;
    }
  }

  private enter(): void {
    const p = this.pending;
    if (!p) return;
    const v = this.buf;
    this.push("user", `${p.prompt.trim()} ${p.hidden ? "*".repeat(Math.min(v.length, 8)) : v}`);
    if (!p.hidden && v.trim() && v !== this.history.at(-1)) this.history.push(v);
    this.scroll = 0;
    this.finish(v);
  }

  private escEsc(): void {
    if (this.pending) {
      this.push("dim", "Esc Esc");
      this.finish(null, new EscInterrupted());
    } else interruptNow("esc");
  }

  private ctrlC(): void {
    if (this.pending) {
      this.push("dim", "^C");
      this.finish(null, new Interrupted());
    } else this.opts.onInterrupt();
  }

  // ---- drawing ----

  private out(s: string): void {
    try {
      Deno.stdout.writeSync(enc.encode(s));
    } catch {
      // terminal gone
    }
  }

  private schedule(): void {
    if (this.dirty || this.closed) return;
    this.dirty = true;
    setTimeout(() => {
      this.dirty = false;
      this.render();
    }, 16);
  }

  private size(): { w: number; h: number } {
    try {
      const s = Deno.consoleSize();
      return { w: Math.max(40, s.columns), h: Math.max(16, s.rows) };
    } catch {
      return { w: 80, h: 24 };
    }
  }

  private bodyHeight(): number {
    return this.size().h - 11;
  }

  private styled(kind: Kind, s: string): string {
    switch (kind) {
      case "dim":
      case "info":
        return COLOR.dim(s);
      case "warn":
        return COLOR.yellow(s);
      case "error":
        return COLOR.red(s);
      case "ok":
        return COLOR.green(s);
      case "bold":
        return COLOR.bold(s);
      case "user":
        return COLOR.bold(s);
      case "assistant":
        return COLOR.cyan(s);
      default:
        return s;
    }
  }

  render(): void {
    if (this.closed) return;
    const { w, h } = this.size();
    const rows: string[] = [];

    // Header.
    const title = ` ${botName(this.status.full)} · ${this.opts.title}`;
    const right = [this.status.model, this.status.location].filter(Boolean).join("  ·  ") + " ";
    rows.push(COLOR.inverse(fit(title, w - [...right].length) + right));

    // The bot and its speech bubble.
    const mood = this.currentMood();
    const art = paintBot(bot(mood, this.frame, Date.now() < this.blinkUntil));
    const bw = Math.max(10, w - 16);
    const said = this.busy && !this.streaming ? `${this.busy.label}...` : this.speech || "...";
    const words = wrap(said.trim(), bw - 4);
    const shown = words.length > 3 ? ["…" + words.at(-3)!.slice(1), ...words.slice(-2)] : words;
    while (shown.length < 3) shown.push("");
    const bubble = [
      "",
      `╭${"─".repeat(bw - 2)}╮`,
      ...shown.map((l) => `│ ${fit(l, bw - 4)} │`),
      `╰${"─".repeat(bw - 2)}╯`,
    ];
    for (let i = 0; i < 6; i++) {
      const tail = i === 2 ? COLOR.cyan(" ◀ ") : "   ";
      const b = bubble[i] ?? "";
      rows.push(` ${art[i]}${b ? tail : "   "}${COLOR.cyan(b)}`);
    }
    rows.push(COLOR.dim("─".repeat(w)));

    // The transcript.
    const body = this.bodyHeight();
    const lines: string[] = [];
    for (const e of this.entries) {
      const prefix = e.kind === "assistant" ? "● " : e.kind === "user" ? "› " : "";
      const wrapped = wrap(prefix + e.text, w - 2);
      for (const l of wrapped) lines.push(this.styled(e.kind, l));
    }
    this.scroll = Math.min(this.scroll, Math.max(0, lines.length - body));
    const end = lines.length - this.scroll;
    const view = lines.slice(Math.max(0, end - body), end);
    while (view.length < body) view.unshift("");
    for (const l of view) rows.push(` ${l}`);

    // Status: what runs now.
    rows.push(COLOR.dim("─".repeat(w)));
    const spin = COLOR.cyan(FRAMES[this.frame % FRAMES.length]);
    const p = [...this.progress.values()].at(-1);
    let status: string;
    if (p) {
      const bar = Math.max(10, Math.min(30, w - 80));
      status = `${spin} ${COLOR.dim(fit(`${p.label}  ${progressText(p, bar)}`, w - 4))}`;
    } else if (this.busy) {
      const s = Math.floor((Date.now() - this.busy.t0) / 1000);
      status = `${spin} ${COLOR.dim(fit(`${this.busy.label}...${s >= 3 ? ` ${s}s` : ""}`, w - 4))}`;
    } else {
      status = COLOR.dim(fit(
        `${
          this.scroll ? `scrolled up ${this.scroll} lines · ` : ""
        }PgUp/PgDn scroll · ↑↓ history · ^C or Esc Esc stop · ^D quit · /help`,
        w - 2,
      ));
    }
    rows.push(` ${status}`);

    // Input.
    let cursorCol = 1;
    if (this.pending) {
      const prompt = this.pending.prompt;
      const text = this.pending.hidden ? "*".repeat([...this.buf].length) : this.buf;
      const room = w - [...prompt].length - 2;
      const chars = [...text];
      const startAt = Math.max(0, this.cursor - room + 1);
      const visible = chars.slice(startAt, startAt + room).join("");
      rows.push(` ${COLOR.bold(prompt)}${visible}`);
      cursorCol = 2 + [...prompt].length + (this.cursor - startAt);
    } else rows.push("");

    // One write per frame: home, each row cleared and drawn, cursor to the input.
    let frame = `${ESC}H`;
    rows.slice(0, h).forEach((r, i) => {
      frame += `${ESC}${i + 1};1H${ESC}2K${r}`;
    });
    frame += this.pending ? `${ESC}${h};${cursorCol}H${ESC}?25h` : `${ESC}?25l`;
    this.out(frame);
  }
}
