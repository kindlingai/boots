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
  busyText,
  type Choice,
  doubleEsc,
  type EngineEvent,
  EscInterrupted,
  type Frontend,
  Interrupted,
  interruptNow,
  progressText,
  QUESTION_GUARD_MS,
  setPrefill,
  steer,
  type Style,
  takePrefill,
  tidy,
  wrapAnsi,
} from "../frontend.ts";

import { bot, type Mood, moodOf, wrap } from "./bot.ts";
import { onTheme, tuiTheme } from "../theme.ts";
export { bot, wrap };

const enc = new TextEncoder();
const dec = new TextDecoder();
const ESC = "\x1b[";
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Text in a theme role's style (theme.ts). */
const paint = (role: string, s: string) => tuiTheme().paint(role, s);

/**
 * The bot in the theme's colours (by default a grey body with white eyes and
 * bright blue boots). The antenna is the body's colour while it is a plain
 * line, the signal's (dark red) when it signals (? * .).
 */
export function paintBot(art: string[]): string[] {
  const [antenna, top, face, mouth, legs, feet] = art;
  const body = (s: string) => paint("bot.body", s);
  // Sweat drops sit in the outer columns of the head rows.
  const edges = (row: string, middle: (s: string) => string) => {
    const tint = (ch: string) => (ch === " " ? ch : paint("bot.sweat", ch));
    return tint(row[0]) + middle(row.slice(1, -1)) + tint(row.at(-1)!);
  };
  const eyesAt = face.indexOf("|");
  const eyesEnd = face.lastIndexOf("|");
  return [
    antenna.trim() === "|" ? body(antenna) : paint("bot.signal", antenna),
    edges(top, body),
    edges(
      face,
      (m) =>
        body(m.slice(0, eyesAt)) + paint("bot.eyes", m.slice(eyesAt, eyesEnd - 1)) +
        body(m.slice(eyesEnd - 1)),
    ),
    edges(mouth, body),
    body(legs),
    paint("bot.boots", feet),
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
  /** The answers it offers: a question, not free text. */
  choices?: Choice[];
  /** Keys before this time are dropped (QUESTION_GUARD_MS). */
  guardUntil?: number;
  resolve: (s: string | null) => void;
  reject: (e: Error) => void;
}

const plain = (s: string) => s.replace(ANSI, "");
const ESC_CHAR = String.fromCharCode(27);
/** The input area grows to this many rows as text wraps. */
const INPUT_ROWS = 4;
/** Every escape code but colours removed. */
const sgrOnly = (s: string) => s.replace(ANSI, (m) => (m.endsWith("m") ? m : ""));

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
  private busy: { label: string; t0: number; note?: string } | null = null;
  private progress = new Map<string, ProgressEv>();
  /** Active goals' titles, shown under the status line. */
  private goals: string[] = [];
  /** The model's latest update_status, in the bubble while it works. */
  private activity: string | null = null;
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
  private offTheme = () => {};

  constructor(private opts: { title: string; onInterrupt: () => void }) {}

  start(): void {
    // A new theme (/theme) shows at once.
    this.offTheme = onTheme(() => this.render());
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
    this.offTheme();
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
        // Colours are kept (commands, verdicts); other escape codes are not.
        for (const l of sgrOnly(e.text).split("\n")) this.push(e.style ?? "plain", l);
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
          ? { label: e.label, t0: e.same && this.busy ? this.busy.t0 : Date.now(), note: e.note }
          : null;
        break;
      case "goals":
        this.goals = e.titles;
        break;
      case "activity":
        this.activity = e.text;
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

  readLine(
    prompt: string,
    hidden = false,
    choices?: Choice[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const p: Pending = { prompt: plain(prompt), hidden, choices, resolve, reject };
      // Out of time: closed unanswered, whether open or still waiting its turn.
      signal?.addEventListener("abort", () => {
        if (this.pending === p) {
          this.push("dim", `${p.prompt.trim()} (no answer)`);
          this.finish(null);
        } else {
          const i = this.queue.indexOf(p);
          if (i >= 0) {
            this.queue.splice(i, 1);
            resolve(null);
          }
        }
      }, { once: true });
      if (this.pending) this.queue.push(p);
      else this.begin(p);
    });
  }

  /** A steering draft set aside while a prompt is open. */
  private draft: { buf: string; cursor: number } | null = null;

  private begin(p: Pending): void {
    this.pending = p;
    const handed = takePrefill();
    if (!p.choices && !p.hidden) {
      // A free-text prompt (the main one): the draft carries over, after what
      // a stop handed back.
      this.buf = [handed, this.buf, this.draft?.buf ?? ""].filter(Boolean).join(" ");
      this.draft = null;
      this.cursor = [...this.buf].length;
      this.historyAt = -1;
      this.schedule();
      return;
    }
    if (handed) setPrefill(handed);
    if (p.choices) p.guardUntil = Date.now() + QUESTION_GUARD_MS;
    if (this.buf && !this.draft) this.draft = { buf: this.buf, cursor: this.cursor };
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
    else if (this.draft) {
      // Back to the draft the prompt interrupted.
      ({ buf: this.buf, cursor: this.cursor } = this.draft);
      this.draft = null;
    } else {
      this.buf = "";
      this.cursor = 0;
    }
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
      carry = this.feed([...carry, ...value]);
      this.schedule();
    }
  }

  /**
   * Handles typed bytes; returns an unfinished escape sequence to carry over.
   * While a question has just opened, keys are dropped: the user may not
   * have seen it yet (^C still stops).
   */
  feed(bytes: number[]): number[] {
    let carry: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      // A question just opened: keys typed for something else are dropped
      // (^C still stops).
      if (b !== 3 && this.pending?.guardUntil && Date.now() < this.pending.guardUntil) continue;
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
    return carry;
  }

  /** Typing works whether or not a prompt is open: without one, it is a steering draft. */
  private edit(f: () => void): void {
    f();
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
        if (!this.pending?.hidden && this.history.length) {
          this.historyAt = Math.min(this.history.length - 1, this.historyAt + 1);
          this.buf = this.history[this.history.length - 1 - this.historyAt];
          this.cursor = [...this.buf].length;
        }
        break;
      case "B":
        if (this.historyAt >= 0) {
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
    if (!p) {
      // While the model works: a message it reads after its current step.
      const v = this.buf.trim();
      if (!v) return;
      this.push("user", v);
      this.push("dim", "  (queued: the model reads it after its current step)");
      if (v !== this.history.at(-1)) this.history.push(v);
      this.buf = "";
      this.cursor = 0;
      this.scroll = 0;
      steer(v);
      return;
    }
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
    const { w, h } = this.size();
    return h - 11 - this.goalRows().length - (this.inputLayout(w).rows.length - 1);
  }

  /**
   * The input area: the prompt (or, while the model works, "› " for a
   * steering message) and what is typed, wrapped at the screen width, at
   * most INPUT_ROWS rows, scrolled so the cursor shows. The cursor's row
   * (within those rows) and column (1-based, on screen).
   */
  private inputLayout(w: number): { rows: string[]; cursorRow: number; cursorCol: number } {
    const steering = !this.pending;
    const prompt = this.pending ? this.pending.prompt : "› ";
    const text = this.pending?.hidden ? "*".repeat([...this.buf].length) : this.buf;
    const width = Math.max(10, w - 2);
    const p = [...prompt];
    const all = [...p, ...[...text]];
    const lines: string[][] = [];
    for (let i = 0; i < all.length; i += width) lines.push(all.slice(i, i + width));
    const at = p.length + this.cursor;
    const cursorLine = Math.floor(at / width);
    while (lines.length <= cursorLine) lines.push([]);
    const first = Math.max(0, Math.min(cursorLine - (INPUT_ROWS - 1), lines.length - INPUT_ROWS));
    const shown = lines.slice(first, first + INPUT_ROWS);
    const rows = shown.map((chars, k) => {
      const line = first + k;
      if (line > 0) return ` ${chars.join("")}`;
      // The first line carries the prompt, styled.
      const head = chars.slice(0, p.length).join("");
      const rest = chars.slice(p.length).join("");
      if (steering && !text) {
        return ` ${paint("dim", head)}${paint("dim", "type to steer the model; Enter sends it")}`;
      }
      return ` ${paint(steering ? "dim" : "prompt", head)}${rest}`;
    });
    return { rows, cursorRow: cursorLine - first, cursorCol: 2 + (at % width) };
  }

  /**
   * The current goal at the top: the first active goal, and its active step
   * when it has one ("Serve GLM › Start TP4"); a count of any other goals.
   */
  private goalRows(): string[] {
    const [goal, ...rest] = this.goals.map(tidy).filter(Boolean);
    if (!goal) return [];
    const step = rest.length ? rest[0] : "";
    const more = rest.length > 1 ? `  (+${rest.length - 1} more)` : "";
    return [`◆ ${goal}${step ? ` › ${step}` : ""}${more}`];
  }

  private styled(kind: Kind, s: string): string {
    return kind === "plain" ? s : paint(kind, s);
  }

  render(): void {
    if (this.closed) return;
    const { w, h } = this.size();
    const rows: string[] = [];

    // Header.
    const title = ` ${botName(this.status.full)} · ${this.opts.title}`;
    const right = [this.status.model, this.status.location].filter(Boolean).join("  ·  ") + " ";
    const theme = tuiTheme();
    rows.push(paint("header", fit(title, w - [...right].length) + right));
    // The current goal, under the header.
    for (const g of this.goalRows()) rows.push(` ${paint("goal", fit(g, w - 2))}`);

    // The bot and its speech bubble.
    const mood = this.currentMood();
    const art = paintBot(bot(mood, this.frame, Date.now() < this.blinkUntil));
    const bw = Math.max(10, w - 16);
    const doing = this.busy && !this.streaming;
    const said = tidy(doing ? this.activity ?? `${this.busy!.label}...` : this.speech) || "...";
    const words = wrap(said, bw - 4);
    // Speech as it streams shows its end; a status or summary its start.
    const shown = words.length <= 3
      ? words
      : doing
      ? [...words.slice(0, 2), words[2].slice(0, -1) + "…"]
      : ["…" + words.at(-3)!.slice(1), ...words.slice(-2)];
    while (shown.length < 3) shown.push("");
    // The frame in the bubble's border colour, the words in its colour.
    const frame = (s: string) => paint("bubble.frame", s);
    const bubble = [
      "",
      frame(`╭${"─".repeat(bw - 2)}╮`),
      ...shown.map((l) => frame("│ ") + paint("bubble", fit(l, bw - 4)) + frame(" │")),
      frame(`╰${"─".repeat(bw - 2)}╯`),
    ];
    for (let i = 0; i < 6; i++) {
      const tail = i === 2 ? ` ${paint("bubble.tail", "◀")} ` : "   ";
      const b = bubble[i] ?? "";
      rows.push(` ${art[i]}${b ? tail : "   "}${b}`);
    }
    rows.push(paint("rule", "─".repeat(w)));

    // The transcript.
    const body = this.bodyHeight();
    const lines: string[] = [];
    const marks = {
      assistant: theme.content("assistant.mark", "● "),
      user: theme.content("user.mark", "› "),
    };
    for (const e of this.entries) {
      const mark = e.kind === "assistant" || e.kind === "user" ? e.kind : null;
      const prefix = mark ? marks[mark] : "";
      // A line with its own colours keeps them (in the theme's); others take their kind's.
      const own = e.text.includes(ESC_CHAR);
      const wrapped = own ? wrapAnsi(prefix + e.text, w - 2) : wrap(prefix + e.text, w - 2);
      wrapped.forEach((l, i) => {
        if (own) lines.push(theme.remap(l));
        else if (mark && i === 0 && l.startsWith(prefix)) {
          // The mark in its own colour.
          lines.push(
            paint(`${mark}.mark`, prefix) + this.styled(e.kind, l.slice(prefix.length)),
          );
        } else lines.push(this.styled(e.kind, l));
      });
    }
    this.scroll = Math.min(this.scroll, Math.max(0, lines.length - body));
    const end = lines.length - this.scroll;
    const view = lines.slice(Math.max(0, end - body), end);
    while (view.length < body) view.unshift("");
    for (const l of view) rows.push(` ${l}`);

    // Status: what runs now.
    rows.push(paint("rule", "─".repeat(w)));
    const spin = paint("spinner", FRAMES[this.frame % FRAMES.length]);
    const p = [...this.progress.values()].at(-1);
    let status: string;
    if (p) {
      const bar = Math.max(10, Math.min(30, w - 80));
      status = `${spin} ${paint("status", fit(`${p.label}  ${progressText(p, bar)}`, w - 4))}`;
    } else if (this.busy) {
      status = `${spin} ${paint("status", fit(busyText(this.busy), w - 4))}`;
    } else {
      status = paint(
        "status",
        fit(
          `${
            this.scroll ? `scrolled up ${this.scroll} lines · ` : ""
          }PgUp/PgDn scroll · ↑↓ history · ^C or Esc Esc stop · ^D quit · /help`,
          w - 2,
        ),
      );
    }
    rows.push(` ${status}`);

    // Input: wraps to at most INPUT_ROWS rows, scrolled to keep the cursor in view.
    const input = this.inputLayout(w);
    rows.push(...input.rows);
    // One write per frame: home, each row cleared and drawn, cursor to the
    // input. A theme with a background clears each row in it (onBase).
    let out = `${ESC}H`;
    const base = theme.base ? `${ESC}${theme.base}m` : "";
    rows.slice(0, h).forEach((r, i) => {
      out += `${ESC}${i + 1};1H${base}${ESC}2K${theme.onBase(r)}`;
    });
    // Rows the screen has below what was drawn (none, normally).
    for (let i = rows.length; i < h; i++) out += `${ESC}${i + 1};1H${base}${ESC}2K`;
    out += `${ESC}0m${ESC}${
      h - input.rows.length + 1 + input.cursorRow
    };${input.cursorCol}H${ESC}?25h`;
    this.out(out);
  }
}
