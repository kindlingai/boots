// The opt-in GUI (ai-bootstrap --gui): the TUI's layout in a window. The
// engine talks to this frontend like any other; it keeps the same state the
// TUI keeps (transcript, speech bubble, busy, progress, the open prompt) and
// serves it to a page over a WebSocket on 127.0.0.1, guarded by a random
// token. The page draws the very same bot (bot.ts, shipped with toString).
//
// The window is a native webview in a child process (`--gui-window`), since a
// webview blocks the event loop while it runs. When no webview can be opened
// (no WebKitGTK, no download), the page opens in the default browser instead.

import {
  botName,
  type Choice,
  type EngineEvent,
  EscInterrupted,
  type Frontend,
  interruptNow,
  progressText,
  steer,
  type Style,
  takePrefill,
} from "../frontend.ts";
import type { Mood } from "./bot.ts";
import { page } from "./gui_page.ts";
import { isWindows, selfArgv } from "../platform.ts";
import { guiCss, onTheme } from "../theme.ts";

type Kind = Style | "user" | "assistant";
type ProgressEv = Extract<EngineEvent, { type: "progress" }>;

interface Pending {
  id: number;
  prompt: string;
  hidden: boolean;
  choices?: Choice[];
  /** Handed back by a stop: shown in the input box. */
  prefill?: string;
  resolve: (s: string | null) => void;
  reject: (e: Error) => void;
}

/** What a page needs to draw everything but the transcript. */
export interface GuiState {
  speech: string;
  status: { model?: string; location?: string; full?: boolean };
  name: string;
  busy: { label: string; t0: number; note?: string } | null;
  progress: { label: string; text: string }[];
  prompt:
    | { id: number; prompt: string; hidden: boolean; choices?: Choice[]; prefill?: string }
    | null;
  flash: { mood: Mood; until: number } | null;
  talkedAt: number;
  streaming: boolean;
  /** Active goals' titles. */
  goals: string[];
  /** The model's latest update_status, shown in the bubble while it works. */
  activity: string | null;
}

/** Messages to the page. */
export type ToPage =
  | { t: "init"; title: string; entries: { kind: Kind; text: string }[]; state: GuiState }
  | { t: "entry"; kind: Kind; text: string }
  | { t: "stream"; text: string }
  | { t: "state"; state: GuiState }
  /** A new theme's stylesheet. */
  | { t: "theme"; css: string }
  /** Asks the page for a picture of itself. */
  | { t: "shot"; id: number }
  | { t: "bye" };

/** Messages from the page. */
export type FromPage =
  | { t: "answer"; id: number; text: string }
  | { t: "steer"; text: string }
  | { t: "stop" }
  | { t: "quit" }
  /** The picture asked for: a PNG in base64, or why there is none. */
  | { t: "shot"; id: number; data?: string; error?: string };

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");
const plain = (s: string) => s.replace(ANSI, "");
const sgrOnly = (s: string) => s.replace(ANSI, (m) => (m.endsWith("m") ? m : ""));

export class GuiFrontend implements Frontend {
  private entries: { kind: Kind; text: string }[] = [];
  private streamingEntry: { kind: Kind; text: string } | null = null;
  private speech = `Hi! I'm ${botName()}. I set up AI models on your machines.`;
  private status: GuiState["status"] = {};
  private busy: GuiState["busy"] = null;
  private progress = new Map<string, ProgressEv>();
  private flash: GuiState["flash"] = null;
  private talkedAt = 0;
  private goals: string[] = [];
  private activity: string | null = null;
  private pending: Pending | null = null;
  private queue: Pending[] = [];
  private nextId = 1;
  private sockets = new Set<WebSocket>();
  private server: Deno.HttpServer | null = null;
  private window: Deno.ChildProcess | null = null;
  private closed = false;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pictures asked of the page (/screenshot), by id. */
  private shots = new Map<number, (r: { data?: string; error?: string }) => void>();
  private offTheme = () => {};
  readonly token = crypto.randomUUID();
  url = "";

  constructor(private opts: { title: string; onQuit?: () => void }) {}

  /** Serves the page on a random local port; returns its URL. */
  serve(): string {
    this.server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (req) => this.handle(req),
    );
    const port = (this.server.addr as Deno.NetAddr).port;
    // A new theme (/theme) shows at once.
    this.offTheme = onTheme(() => this.broadcast({ t: "theme", css: guiCss() }));
    this.url = `http://127.0.0.1:${port}/?t=${this.token}`;
    return this.url;
  }

  /**
   * Opens the window: a native webview in a child process, or the default
   * browser if that cannot start. Closing the native window quits.
   */
  async open(log: (s: string) => void = () => {}): Promise<"window" | "browser" | "none"> {
    if (Deno.env.get("AIBOOT_GUI_WINDOW") !== "browser") {
      try {
        const [cmd, ...pre] = selfArgv();
        const child = new Deno.Command(cmd, {
          args: [...pre, "--gui-window", this.url, this.opts.title],
          stdin: "null",
          stdout: "null",
          stderr: "piped",
        }).spawn();
        this.window = child;
        // A window that fails does so at once (no library, no display).
        const early = await Promise.race([
          child.status.then((s) => s),
          new Promise<null>((ok) => setTimeout(() => ok(null), 4000)),
        ]);
        if (early === null) {
          child.status.then(() => {
            if (!this.closed) this.quit();
          });
          child.stderr.cancel().catch(() => {});
          return "window";
        }
        const why = (await new Response(child.stderr).text()).trim().split("\n").slice(-2).join(
          " ",
        );
        log(`no native window (${why || `exit ${early.code}`}); opening the browser`);
        this.window = null;
      } catch (e) {
        log(`no native window (${(e as Error).message}); opening the browser`);
      }
    }
    return (await openBrowser(this.url)) ? "browser" : "none";
  }

  private handle(req: Request): Response {
    const u = new URL(req.url);
    if (u.searchParams.get("t") !== this.token) return new Response("forbidden", { status: 403 });
    if (u.pathname === "/ws") {
      // Only our own page may connect.
      const origin = req.headers.get("origin");
      if (origin && origin !== `http://127.0.0.1:${u.port}`) {
        return new Response("forbidden", { status: 403 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => {
        this.sockets.add(socket);
        this.sendTo(socket, {
          t: "init",
          title: this.opts.title,
          entries: this.entries,
          state: this.state(),
        });
      };
      socket.onmessage = (m) => {
        try {
          this.receive(JSON.parse(String(m.data)));
        } catch {
          // not ours
        }
      };
      socket.onclose = () => this.sockets.delete(socket);
      return response;
    }
    if (u.pathname === "/") {
      return new Response(page(this.opts.title, this.token, guiCss()), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response("not found", { status: 404 });
  }

  private receive(m: FromPage): void {
    if (m.t === "answer" && this.pending && m.id === this.pending.id) {
      const p = this.pending;
      const picked = p.choices?.find((c) => c.key === m.text.trim().toLowerCase());
      this.push(
        "user",
        picked
          ? picked.label
          : `${p.prompt.trim()} ${p.hidden ? "*".repeat(Math.min(m.text.length, 8)) : m.text}`,
      );
      this.finish(m.text);
    } else if (m.t === "steer" && !this.pending) {
      const v = String(m.text ?? "").trim();
      if (v) {
        this.push("user", v);
        this.push("dim", "(queued: the model reads it after its current step)");
        steer(v);
      }
    } else if (m.t === "stop") {
      // The Stop button, Esc Esc or ^C in the page: stops like Esc Esc in the
      // TUI (cancels a tool's question or what runs; never quits).
      if (this.pending) {
        this.push("dim", "stopped");
        this.finish(null, new EscInterrupted());
      } else interruptNow("esc");
    } else if (m.t === "quit") this.quit();
    else if (m.t === "shot") this.shots.get(m.id)?.(m);
  }

  /**
   * The window as a PNG, drawn by the page itself (the most recently opened
   * one, when there are several). Throws when no page is open or it cannot.
   */
  async screenshot(timeoutMs = 20_000): Promise<Uint8Array> {
    const socket = [...this.sockets].filter((s) => s.readyState === WebSocket.OPEN).at(-1);
    if (!socket) throw new Error("the GUI has no window open");
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await new Promise<{ data?: string; error?: string }>((ok) => {
        this.shots.set(id, ok);
        timer = setTimeout(() => ok({ error: "the window did not answer" }), timeoutMs);
        this.sendTo(socket, { t: "shot", id });
      });
      if (!r.data) throw new Error(r.error || "the window sent no picture");
      return Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    } finally {
      clearTimeout(timer);
      this.shots.delete(id);
    }
  }

  private quit(): void {
    if (this.closed) return;
    // End of input: the prompt open now, and every later one, gets null.
    this.closed = true;
    this.finish(null);
    for (const q of this.queue.splice(0)) q.resolve(null);
    this.opts.onQuit?.();
  }

  // ---- the Frontend interface ----

  emit(e: EngineEvent): void {
    switch (e.type) {
      case "line": {
        // Colours are kept (the page draws them); other escape codes are not.
        for (const l of sgrOnly(e.text).split("\n")) this.push(e.style ?? "plain", l);
        if (e.style === "error") this.mood("sad", 4000);
        if (e.style === "ok") this.mood("happy", 3000);
        break;
      }
      case "assistant":
        if (e.phase === "start") {
          this.streamingEntry = { kind: "assistant", text: "" };
          this.entries.push(this.streamingEntry);
          this.broadcast({ t: "entry", kind: "assistant", text: "" });
          this.speech = "";
        } else if (e.phase === "delta" && this.streamingEntry) {
          this.streamingEntry.text += e.text ?? "";
          this.speech = this.streamingEntry.text;
          this.broadcast({ t: "stream", text: this.streamingEntry.text });
        } else {
          this.streamingEntry = null;
        }
        this.talkedAt = Date.now();
        break;
      case "busy":
        this.busy = e.label
          ? { label: e.label, t0: e.same && this.busy ? this.busy.t0 : Date.now(), note: e.note }
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
      case "goals":
        this.goals = e.titles;
        break;
      case "activity":
        this.activity = e.text;
        break;
      case "status": {
        const handedOver = e.full !== undefined && !!e.full !== !!this.status.full;
        this.status = { ...this.status, ...e };
        if (handedOver && !this.streamingEntry) {
          this.speech = e.full
            ? `I'm ${botName(true)} now${e.model ? `, running on ${e.model}` : ""}.`
            : `Back to being ${botName()}, on the bootstrap model.`;
          this.mood(e.full ? "happy" : "sad", 2500);
        }
        break;
      }
    }
    this.stateSoon();
  }

  readLine(
    prompt: string,
    hidden = false,
    choices?: Choice[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (this.closed || signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const p: Pending = {
        id: this.nextId++,
        prompt: plain(prompt),
        hidden,
        choices,
        resolve,
        reject,
      };
      if (!choices && !hidden) p.prefill = takePrefill() || undefined;
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

  close(): void {
    this.closed = true;
    this.broadcast({ t: "bye" });
    clearTimeout(this.stateTimer);
    this.offTheme();
    for (const s of this.sockets) {
      try {
        s.close();
      } catch {
        // gone
      }
    }
    try {
      this.window?.kill();
    } catch {
      // gone
    }
    this.server?.shutdown().catch(() => {});
  }

  // ---- state ----

  private begin(p: Pending): void {
    this.pending = p;
    this.stateSoon(true);
  }

  private finish(value: string | null, error?: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (error) p.reject(error);
    else p.resolve(value);
    const next = this.queue.shift();
    if (next) this.begin(next);
    this.stateSoon(true);
  }

  private push(kind: Kind, text: string): void {
    const e = { kind, text };
    this.entries.push(e);
    if (this.entries.length > 2000) this.entries.splice(0, this.entries.length - 2000);
    this.broadcast({ t: "entry", ...e });
  }

  private mood(m: Mood, ms: number): void {
    this.flash = { mood: m, until: Date.now() + ms };
  }

  state(): GuiState {
    return {
      speech: this.speech,
      status: this.status,
      name: botName(this.status.full),
      busy: this.busy,
      progress: [...this.progress.values()].map((p) => ({
        label: p.label,
        text: progressText(p, 24),
      })),
      prompt: this.pending
        ? {
          id: this.pending.id,
          prompt: this.pending.prompt,
          hidden: this.pending.hidden,
          choices: this.pending.choices,
          prefill: this.pending.prefill,
        }
        : null,
      flash: this.flash,
      talkedAt: this.talkedAt,
      streaming: !!this.streamingEntry,
      goals: this.goals,
      activity: this.activity,
    };
  }

  /** State updates, at most every 100 ms (now, for a prompt opening or closing). */
  private stateSoon(now = false): void {
    if (now) {
      clearTimeout(this.stateTimer);
      this.stateTimer = undefined;
      this.broadcast({ t: "state", state: this.state() });
      return;
    }
    this.stateTimer ??= setTimeout(() => {
      this.stateTimer = undefined;
      this.broadcast({ t: "state", state: this.state() });
    }, 100);
  }

  private broadcast(m: ToPage): void {
    for (const s of this.sockets) this.sendTo(s, m);
  }

  private sendTo(s: WebSocket, m: ToPage): void {
    if (s.readyState !== WebSocket.OPEN) return;
    try {
      s.send(JSON.stringify(m));
    } catch {
      // closing
    }
  }
}

/** Opens a URL in the default browser. False when there is no way to. */
export async function openBrowser(url: string): Promise<boolean> {
  const cmd = Deno.build.os === "darwin"
    ? ["open", url]
    : isWindows
    ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    const o = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return o.success;
  } catch {
    return false;
  }
}
