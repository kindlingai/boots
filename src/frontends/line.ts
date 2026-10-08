// The line frontend: a classic REPL on stdout. Spinners and progress bars
// share one "live" line at the bottom, redrawn in place and cleared before
// anything else prints. Without a terminal it prints plain lines instead.

import {
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
} from "../frontend.ts";
import { lineTheme } from "../theme.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const color = Deno.stdout.isTerminal() && !Deno.env.get("NO_COLOR");
/** In a theme role's colours (theme.ts; not its background: lines scroll). */
const role = (r: string) => (s: string) => color ? lineTheme().paint(r, s) : s;
const dim = role("dim");
const STYLE: Record<Style, (s: string) => string> = {
  plain: (s) => s,
  dim,
  info: role("info"),
  warn: role("warn"),
  error: role("error"),
  ok: role("ok"),
  bold: role("bold"),
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

  constructor() {
    this.input.onDraft = (d) => {
      this.draft = d;
      this.drawLive();
    };
    this.input.onSend = (text) => {
      this.print(
        `${STYLE.bold("›")} ${text}  ${dim("(queued: the model reads it after its current step)")}`,
      );
      steer(text);
    };
  }

  emit(e: EngineEvent): void {
    switch (e.type) {
      case "line": {
        const text = STYLE[e.style ?? "plain"](color ? lineTheme().remap(e.text) : e.text);
        this.print(text, e.style === "info" || e.style === "warn");
        break;
      }
      case "assistant":
        if (e.phase === "start") {
          this.clearLive();
          this.streaming = true;
          write(role("assistant.mark")(lineTheme().content("assistant.mark", "● ")));
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

  async readLine(
    prompt: string,
    hidden = false,
    choices?: Choice[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    this.clearLive();
    this.input.unwatch();
    this.reading = true;
    const free = !choices && !hidden;
    const handed = takePrefill();
    if (handed && !free) setPrefill(handed);
    try {
      return await this.input.readLine(
        prompt,
        hidden,
        signal,
        free,
        free ? handed : "",
        choices ? QUESTION_GUARD_MS : 0,
      );
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

  /** What was typed while the model works (sent with Enter). */
  private draft = "";

  private liveText(): string | null {
    const f = role("spinner")(FRAMES[this.frame % FRAMES.length]);
    const p = [...this.progress.values()].at(-1);
    const typed = this.draft ? `  › ${this.draft}` : "";
    if (p) return `${f} ${p.label}  ${dim(progressText(p))}${typed}`;
    if (this.busy) {
      return `${f} ${dim(busyText(this.busy))}${typed}`;
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
/** A prompt closed by its deadline. */
const ABORTED = Symbol("aborted");

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
        // ^C and a lone Esc are ours; text typed is a steering draft (Enter
        // sends it to the model); other keys wait for the prompt.
        const got = this.buf.splice(0);
        const kept: number[] = [];
        for (let k = 0; k < got.length; k++) {
          const b = got[k];
          if (b === 3) interruptNow("ctrl-c");
          else if (b === 27 && got.length === 1) {
            if (this.esc()) interruptNow("esc");
          } else if (b === 27) {
            // An escape sequence (arrows...): not text.
            k++;
            if (got[k] === 91 || got[k] === 79) {
              while (k + 1 < got.length && got[k + 1] < 64) k++;
            }
            k++;
          } else if (b === 13 || b === 10) {
            const text = dec.decode(new Uint8Array(this.draft)).trim();
            this.draft = [];
            this.onDraft("");
            if (text) this.onSend(text);
          } else if (b === 127 || b === 8) {
            const chars = [...dec.decode(new Uint8Array(this.draft))];
            chars.pop();
            this.draft = [...new TextEncoder().encode(chars.join(""))];
            this.onDraft(chars.join(""));
          } else if (b >= 32) {
            this.draft.push(b);
            this.onDraft(dec.decode(new Uint8Array(this.draft)));
          } else kept.push(b);
        }
        this.buf.unshift(...kept);
      }
    })().catch(() => {});
  }

  /** Text typed while something ran, not yet sent. */
  private draft: number[] = [];
  /** The draft changed (for the live line). */
  onDraft: (text: string) => void = () => {};
  /** Enter on a draft: a message for the model. */
  onSend: (text: string) => void = () => {};

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

  /**
   * The next byte, or ABORTED when `signal` fires first. It waits on the
   * shared read, not on taking a byte, so a byte arriving after the abort
   * stays in the buffer for the next prompt.
   */
  private async nextByte(signal?: AbortSignal): Promise<number | null | typeof ABORTED> {
    if (!signal) return await this.byte();
    const stop = new Promise<void>((ok) =>
      signal.addEventListener("abort", () => ok(), { once: true })
    );
    while (!this.buf.length && !this.eof) {
      if (signal.aborted) return ABORTED;
      await Promise.race([this.fill(), stop]);
    }
    if (signal.aborted && !this.buf.length) return ABORTED;
    return this.buf.length ? this.buf.shift()! : null;
  }

  /**
   * Reads one line. Returns null at EOF or when `signal` aborts. Ctrl-C
   * throws Interrupted. A free-text prompt starts with `prefill` and any
   * unsent draft typed in; a question (y/n...) leaves the draft for later.
   */
  readLine(
    prompt: string,
    hidden = false,
    signal?: AbortSignal,
    free = false,
    prefill = "",
    guardMs = 0,
  ): Promise<string | null> {
    const run = async () => {
      if (signal?.aborted) return null;
      if (free) {
        const typed = [
          ...new TextEncoder().encode(prefill ? `${prefill}${this.draft.length ? " " : ""}` : ""),
          ...this.draft,
        ];
        this.buf.unshift(...typed);
        this.draft = [];
        this.onDraft("");
      }
      const tty = Deno.stdin.isTerminal();
      write(prompt);
      if (!tty) {
        const l = await this.cookedLine(signal);
        if (l === ABORTED) {
          write("(no answer)\n");
          return null;
        }
        // Piped input is not echoed; end the prompt line ourselves.
        if (!Deno.stdout.isTerminal()) write(hidden ? "***\n" : `${l ?? ""}\n`);
        return l;
      }
      Deno.stdin.setRaw(true);
      this.prompting = true;
      try {
        if (guardMs) {
          // A question just opened: what was typed for something else, a
          // moment ago or during this pause, is read and dropped (keys still
          // in the terminal's buffer included).
          const until = Date.now() + guardMs;
          this.buf.length = 0;
          while (Date.now() < until && !this.eof) {
            await Promise.race([
              this.fill(),
              new Promise((r) => setTimeout(r, Math.max(1, until - Date.now()))),
            ]);
            if (Date.now() < until) this.buf.length = 0;
          }
        }
        const l = await this.rawLine(hidden, signal);
        if (l === ABORTED) {
          write(" (no answer)\r\n");
          return null;
        }
        return l;
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

  private async cookedLine(signal?: AbortSignal): Promise<string | null | typeof ABORTED> {
    const out: number[] = [];
    while (true) {
      const b = await this.nextByte(signal);
      if (b === ABORTED) return ABORTED;
      if (b === null) return out.length ? dec.decode(new Uint8Array(out)) : null;
      if (b === 10) break;
      if (b !== 13) out.push(b);
    }
    return dec.decode(new Uint8Array(out));
  }

  private async rawLine(
    hidden: boolean,
    signal?: AbortSignal,
  ): Promise<string | null | typeof ABORTED> {
    let s = "";
    let pending: number[] = [];
    while (true) {
      const b = await this.nextByte(signal);
      if (b === ABORTED) return ABORTED;
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
