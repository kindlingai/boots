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
  | { type: "busy"; label: string | null }
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
  /** What the header shows: the model in use, the location. */
  | { type: "status"; model?: string; location?: string };

export interface Frontend {
  emit(e: EngineEvent): void;
  /** One line of input; null at end of input. Throws Interrupted on ^C. */
  readLine(prompt: string, hidden?: boolean): Promise<string | null>;
  /** Called before the process exits (restore the terminal). */
  close(): void;
}

export class Interrupted extends Error {
  constructor() {
    super("interrupted");
  }
}

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
