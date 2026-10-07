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
  type EngineEvent,
  EscInterrupted,
  type Frontend,
  interruptNow,
  progressText,
  type Style,
} from "../frontend.ts";
import type { Mood } from "./bot.ts";
import { page } from "./gui_page.ts";
import { isWindows, selfArgv } from "../platform.ts";

type Kind = Style | "user" | "assistant";
type ProgressEv = Extract<EngineEvent, { type: "progress" }>;

interface Pending {
  id: number;
  prompt: string;
  hidden: boolean;
  resolve: (s: string | null) => void;
  reject: (e: Error) => void;
}

/** What a page needs to draw everything but the transcript. */
export interface GuiState {
  speech: string;
  status: { model?: string; location?: string; full?: boolean };
  name: string;
  busy: { label: string; t0: number } | null;
  progress: { label: string; text: string }[];
  prompt: { id: number; prompt: string; hidden: boolean } | null;
  flash: { mood: Mood; until: number } | null;
  talkedAt: number;
  streaming: boolean;
  /** Active goals' titles. */
  goals: string[];
}

/** Messages to the page. */
export type ToPage =
  | { t: "init"; title: string; entries: { kind: Kind; text: string }[]; state: GuiState }
  | { t: "entry"; kind: Kind; text: string }
  | { t: "stream"; text: string }
  | { t: "state"; state: GuiState }
  | { t: "bye" };

/** Messages from the page. */
export type FromPage =
  | { t: "answer"; id: number; text: string }
  | { t: "stop" }
  | { t: "quit" };

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");
const plain = (s: string) => s.replace(ANSI, "");

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
  private pending: Pending | null = null;
  private queue: Pending[] = [];
  private nextId = 1;
  private sockets = new Set<WebSocket>();
  private server: Deno.HttpServer | null = null;
  private window: Deno.ChildProcess | null = null;
  private closed = false;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
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
      return new Response(page(this.opts.title, this.token), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response("not found", { status: 404 });
  }

  private receive(m: FromPage): void {
    if (m.t === "answer" && this.pending && m.id === this.pending.id) {
      const p = this.pending;
      this.push(
        "user",
        `${p.prompt.trim()} ${p.hidden ? "*".repeat(Math.min(m.text.length, 8)) : m.text}`,
      );
      this.finish(m.text);
    } else if (m.t === "stop") {
      // The Stop button, Esc Esc or ^C in the page: stops like Esc Esc in the
      // TUI (cancels a tool's question or what runs; never quits).
      if (this.pending) {
        this.push("dim", "stopped");
        this.finish(null, new EscInterrupted());
      } else interruptNow("esc");
    } else if (m.t === "quit") this.quit();
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
        for (const l of plain(e.text).split("\n")) this.push(e.style ?? "plain", l);
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
      case "goals":
        this.goals = e.titles;
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

  readLine(prompt: string, hidden = false): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const p: Pending = { id: this.nextId++, prompt: plain(prompt), hidden, resolve, reject };
      if (this.pending) this.queue.push(p);
      else this.begin(p);
    });
  }

  close(): void {
    this.closed = true;
    this.broadcast({ t: "bye" });
    clearTimeout(this.stateTimer);
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
        ? { id: this.pending.id, prompt: this.pending.prompt, hidden: this.pending.hidden }
        : null,
      flash: this.flash,
      talkedAt: this.talkedAt,
      streaming: !!this.streamingEntry,
      goals: this.goals,
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
