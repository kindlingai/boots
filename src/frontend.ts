// The engine/frontend boundary. The engine (agent, tools, boot, model
// management) emits events and asks for input; a frontend draws them. Two
// frontends exist: the line REPL (frontends/line.ts) and the full-screen TUI
// (frontends/tui.ts). A GUI would be a third.

export type Style = "plain" | "dim" | "info" | "warn" | "error" | "ok" | "bold";

export type EngineEvent =
  /** A transcript line. Text may carry ANSI colour; frontends may strip it. */
  | { type: "line"; text: string; style?: Style }
  /** The assistant's reply, streamed: start, any number of deltas, end. */
  | { type: "assistant"; phase: "start" | "delta" | "end"; text?: string }
  /** Something is in progress without a measure ("thinking", "checking the command"); null ends it. */
  | {
    type: "busy";
    label: string | null;
    same?: boolean;
    /** Shown after the time, e.g. "312 tokens". */
    note?: string;
  }
  /** A measurable task: a download, a model loading. `total` absent: indeterminate. */
  | {
    type: "progress";
    id: string;
    label: string;
    done: number;
    total?: number;
    /** Bytes per second, when it is a transfer. */
    rate?: number;
    /** Shown instead of the numbers, e.g. "loading the model". */
    note?: string;
  }
  | { type: "progress-end"; id: string; ok: boolean; text?: string }
  /**
   * What the header shows: the model in use, the location, and whether the
   * full model (rather than the bootstrap) is answering.
   */
  | { type: "status"; model?: string; location?: string; full?: boolean }
  /** The model's latest update_status, for the speech bubble while it works; null clears it. */
  | { type: "activity"; text: string | null }
  /** The active goals' titles (never their details), for showing under the status line. */
  | { type: "goals"; titles: string[] };

/** The bot's name: lil boots on the bootstrap model, Boots once the full model answers. */
export function botName(full?: boolean): string {
  return full ? "Boots" : "lil boots";
}

/** One answer a prompt offers: its key (what readLine returns) and its label. */
export interface Choice {
  key: string;
  label: string;
}

/**
 * Text for the box at the top (speech bubble, goals, status): no surrounding
 * whitespace, and no colon left dangling at the end ("Let me check:").
 */
export function tidy(s: string): string {
  return s.trim().replace(/\s*:+$/, "").trim();
}

/** "thinking... 5s · 312 tokens": the busy line every frontend shows. */
export function busyText(
  b: { label: string; t0: number; note?: string },
  now = Date.now(),
): string {
  const s = Math.floor((now - b.t0) / 1000);
  return `${b.label}...${s >= 3 ? ` ${s}s` : ""}${b.note ? ` · ${b.note}` : ""}`;
}

export interface Frontend {
  emit(e: EngineEvent): void;
  /** A picture of the window as a PNG (the GUI; others have no window to take). */
  screenshot?(): Promise<Uint8Array>;
  /**
   * One line of input; null at end of input. Throws Interrupted on ^C.
   * `choices`, when given, are the answers the prompt offers (the GUI shows
   * them as buttons in place of the input box); the answer is a choice's key.
   */
  readLine(
    prompt: string,
    hidden?: boolean,
    choices?: Choice[],
    /** Closes the prompt unanswered (null) when it aborts: a prompt with a deadline. */
    signal?: AbortSignal,
  ): Promise<string | null>;
  /** Called before the process exits (restore the terminal). */
  close(): void;
}

export class Interrupted extends Error {
  constructor() {
    super("interrupted");
  }
}

/** Esc Esc at a prompt: cancels a tool's question, but never quits at the main prompt. */
export class EscInterrupted extends Interrupted {}

let current: Frontend | null = null;
let fallback: (() => Frontend) | null = null;

/** The frontend in use; the line frontend unless another was installed. */
export function frontend(): Frontend {
  if (!current) {
    if (!fallback) throw new Error("no frontend");
    current = fallback();
  }
  return current;
}

export function setFrontend(f: Frontend): void {
  current = f;
}

/** The frontend used when none was chosen (set by ui.ts, to avoid an import cycle). */
export function setDefaultFrontend(make: () => Frontend): void {
  fallback = make;
}

/** "ctrl-c" stops what runs, or quits when nothing does; "esc" (Esc Esc) only stops. */
export type InterruptKind = "ctrl-c" | "esc";
let interruptHandler: (kind: InterruptKind) => void = () => {};

/** What ^C or Esc Esc does outside a prompt: set by main, called by frontends. */
export function setInterruptHandler(fn: (kind: InterruptKind) => void): void {
  interruptHandler = fn;
}

export function interruptNow(kind: InterruptKind): void {
  interruptHandler(kind);
}

/** Esc pressed twice within this long counts as ^C. */
export const DOUBLE_ESC_MS = 2000;

/** Tells whether an Esc press is the second within DOUBLE_ESC_MS of the first. */
export function doubleEsc(now: () => number = Date.now): () => boolean {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last <= DOUBLE_ESC_MS) {
      last = -Infinity;
      return true;
    }
    last = t;
    return false;
  };
}

export function emit(e: EngineEvent): void {
  frontend().emit(e);
}

// Formatting shared by frontends.

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}

export function fmtDuration(s: number): string {
  if (!isFinite(s) || s < 0) return "?";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** "[██████░░░░] 61%  8.4/13.8 GB  24.1 MB/s  ETA 3m 44s", fitted to `width` for the bar. */
export function progressText(
  p: Extract<EngineEvent, { type: "progress" }>,
  barWidth = 20,
): string {
  if (p.note && !p.total) return p.note;
  if (!p.total) {
    return `${fmtBytes(p.done)}${p.rate ? `  ${fmtBytes(p.rate)}/s` : ""}`;
  }
  const frac = Math.max(0, Math.min(1, p.done / p.total));
  const filled = Math.round(frac * barWidth);
  const bar = `[${"█".repeat(filled)}${"░".repeat(barWidth - filled)}]`;
  const eta = p.rate && p.rate > 0 ? `  ETA ${fmtDuration((p.total - p.done) / p.rate)}` : "";
  return `${bar} ${String(Math.floor(frac * 100)).padStart(3)}%  ${fmtBytes(p.done)}/${
    fmtBytes(p.total)
  }${p.rate ? `  ${fmtBytes(p.rate)}/s` : ""}${eta}${p.note ? `  ${p.note}` : ""}`;
}

/**
 * Reports a task's progress, at most every 250 ms, with a rate smoothed over
 * the last ~10 s so the ETA does not jump around.
 */
export class Progress {
  private samples: [number, number][] = [];
  private last = 0;
  private ended = false;

  constructor(readonly id: string, public label: string, public total?: number) {}

  update(done: number, note?: string, force = false): void {
    if (this.ended) return;
    const now = Date.now();
    this.samples.push([now, done]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 10_000) this.samples.shift();
    if (!force && now - this.last < 250) return;
    this.last = now;
    const [t0, d0] = this.samples[0];
    const rate = now - t0 > 500 ? Math.max(0, ((done - d0) * 1000) / (now - t0)) : undefined;
    emit({
      type: "progress",
      id: this.id,
      label: this.label,
      done,
      total: this.total,
      rate: rate || undefined,
      note,
    });
  }

  end(ok = true, text?: string): void {
    if (this.ended) return;
    this.ended = true;
    emit({ type: "progress-end", id: this.id, ok, text });
  }
}

/** Copies a download to `w`, reporting progress against Content-Length when there is one. */
export async function downloadTo(
  r: Response,
  w: WritableStream<Uint8Array>,
  p: Progress,
): Promise<number> {
  const total = Number(r.headers.get("content-length")) || undefined;
  if (total) p.total = total;
  let done = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      done += chunk.length;
      p.update(done);
      c.enqueue(chunk);
    },
  });
  await r.body!.pipeThrough(counter).pipeTo(w);
  p.update(done, undefined, true);
  return done;
}

const ESC_CHAR = String.fromCharCode(27);
const SGR = new RegExp(`${ESC_CHAR}\\[([0-9;]*)m`, "y");

/**
 * Wraps text that carries colour codes to `w` visible columns, breaking at
 * spaces where it can. Each line ends with a reset and the next one reopens
 * the colours in effect, so every line stands on its own.
 */
export function wrapAnsi(text: string, w: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    // Visible characters, each with the colour codes in effect before it.
    const cells: { ch: string; sgr: string }[] = [];
    let open = "";
    for (let i = 0; i < raw.length;) {
      SGR.lastIndex = i;
      const m = SGR.exec(raw);
      if (m) {
        open = m[1] === "0" || m[1] === "" ? "" : open + m[0];
        i += m[0].length;
        continue;
      }
      const ch = String.fromCodePoint(raw.codePointAt(i)!);
      cells.push({ ch: ch === "\t" ? "  " : ch, sgr: open });
      i += ch.length;
    }
    const draw = (cs: { ch: string; sgr: string }[]) => {
      let s = "", cur = "";
      for (const c of cs) {
        if (c.sgr !== cur) {
          s += `${ESC_CHAR}[0m${c.sgr}`;
          cur = c.sgr;
        }
        s += c.ch;
      }
      return cur ? `${s}${ESC_CHAR}[0m` : s;
    };
    let rest = cells;
    if (!rest.length) {
      out.push("");
      continue;
    }
    while (rest.length > w) {
      let cut = rest.slice(0, w + 1).map((c) => c.ch).lastIndexOf(" ");
      if (cut <= w / 3) cut = w;
      let line = rest.slice(0, cut);
      while (line.length && line.at(-1)!.ch === " ") line = line.slice(0, -1);
      out.push(draw(line));
      rest = rest.slice(cut);
      if (rest[0]?.ch === " ") rest = rest.slice(1);
    }
    out.push(draw(rest));
  }
  return out;
}

/** Messages the user sent while the model was working, oldest first. */
const steering: string[] = [];

/** Runs a /command typed while the model works (set by the REPL). */
let commandHandler: ((text: string) => void) | null = null;

export function setCommandHandler(h: ((text: string) => void) | null): void {
  commandHandler = h;
}

/**
 * Something typed while the model works: a /command runs at once ("command"),
 * anything else is queued for the model, which reads it after its current
 * step ("queued"). `commands` false: queued as it is.
 */
export function steer(text: string, commands = true): "queued" | "command" | "empty" {
  const t = text.trim();
  if (!t) return "empty";
  if (commands && commandHandler && /^\/[a-z]/i.test(t)) {
    commandHandler(t);
    return "command";
  }
  steering.push(t);
  return "queued";
}

/** Takes the queued messages (and empties the queue). */
export function takeSteering(): string[] {
  return steering.splice(0);
}

/** Text for the next free-text prompt's input box (what a stop handed back). */
let prefill = "";

export function setPrefill(text: string): void {
  prefill = text;
}

/** The prefill, once: a free-text prompt takes it as it opens. */
export function takePrefill(): string {
  const t = prefill;
  prefill = "";
  return t;
}

/**
 * A question that interrupts (one with choices) ignores keys for this long
 * as it opens: keys meant for something else, typed a moment before it
 * appeared, must not answer it.
 */
export const QUESTION_GUARD_MS = 500;
