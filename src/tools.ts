// The tools the model can call, and the session state they act on.

import { join } from "@std/path";
import { b64, DEFAULT_TIMEOUT_MS, type ExecResult, Host, type HostInfo } from "./host.ts";
import { chat, type Endpoint, reachable, type Router, type ToolDef } from "./llm.ts";
import type { Memory } from "./memory.ts";
import type { McpManager } from "./mcp.ts";
import { isReadonly, stages } from "./readonly.ts";
import { describeFailure, type FullFailure, scriptPath, startFull } from "./intelligence.ts";
import { secrets } from "./secrets.ts";
import { contextFor, sizeFromName } from "./discover.ts";
import { dataDir, ensureDir } from "./platform.ts";
import {
  type ApprovalKind,
  approve,
  askSecret,
  bold,
  dim,
  green,
  info,
  red,
  yellow,
} from "./ui.ts";
import { Classifier, type Verdict } from "./classify.ts";

/** Wrappers that run the command after them. */
const WRAPPERS = new Set([
  "nohup",
  "exec",
  "env",
  "time",
  "setsid",
  "caffeinate",
  "nice",
  "command",
]);

/** The program each stage runs, past assignments and wrappers, with its arguments. */
function commands(cmd: string): string[][] {
  const st = stages(cmd) ??
    cmd.split(/&&|\|\||[;|&\n()]/).map((p) => p.trim().split(/\s+/).filter(Boolean));
  return st.map((words) => {
    let i = 0;
    while (
      i < words.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(words[i]) ||
        (i > 0 && WRAPPERS.has(words[i - 1]) && words[i].startsWith("-")))
    ) i++;
    return words.slice(i).map((w, j) => j === 0 ? w.replace(/^.*\//, "") : w);
  }).filter((w) => w.length);
}

/** Starts an inference server that stays in the foreground. */
function startsServer(words: string[]): boolean {
  const [head, ...rest] = words;
  if (rest.some((w) => /^(--version|--help|-h)$/.test(w))) return false;
  if (["llama-server", "tritonserver", "text-generation-launcher"].includes(head)) return true;
  if (head === "ollama" || head === "vllm") return rest[0] === "serve";
  if (head === "lms") return rest[0] === "server" && rest[1] === "start";
  if (/^python[0-9.]*$/.test(head)) {
    const m = rest[rest.indexOf("-m") + 1] ?? "";
    return rest.includes("-m") && /^(vllm|sglang|llama_cpp|mlx_lm)\b/.test(m) &&
      /server|serve|entrypoints/.test(rest.join(" "));
  }
  return false;
}

/** Commands that run must not take: they need another tool. Returns why, or null. */
export function refuseInRun(cmd: string): string | null {
  const cmds = commands(cmd);
  if (cmds.some((w) => w[0] === "sudo")) {
    return "sudo inside run: use the sudo tool, with the command without the word sudo. (Inspection rarely needs root: try it without first.)";
  }
  if (cmds.some(startsServer)) {
    return "this starts a model server, which would block until it times out. Write the command into a start script instead: for the model ai-bootstrap should use, start-full.sh in the startup scripts folder, started with start_full_model. For another server, start-<name>.sh in that machine's startup scripts folder, run in the background with its output to a log: nohup sh <script> > <name>.log 2>&1 &";
  }
  return null;
}

/** The same command again within this window is not run (the model is going in circles). */
const REPEAT_WINDOW_MS = 60_000;

/** Lines of each command's output shown to the user (the model gets more). */
const SHOWN_LINES = 5;

export interface Location {
  label: string;
  via: string[];
  info: HostInfo;
}

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "done" | "failed" | "skipped";
  note?: string;
}

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});
const str = (description: string) => ({ type: "string", description });

export const TOOLS: ToolDef[] = [
  fn(
    "run",
    "Run a shell command on the current host (see Location). Read-only commands run at once; anything else asks the user first. cd persists between calls; environment variables do not. Use the sudo tool for root, and the ssh tool to reach other machines.",
    {
      command: str("the command"),
      timeout_s: {
        type: "integer",
        description:
          "seconds before the command and everything it started are stopped (default 30); raise it only for a known long step such as a download or build",
      },
    },
    ["command"],
  ),
  fn(
    "sudo",
    "Run a command as root on the current host. Always asks the user; handles the sudo password itself. Never put `sudo` inside `run`.",
    {
      command: str("the command, without the word sudo"),
      timeout_s: { type: "integer", description: "as for run (default 30)" },
    },
    ["command"],
  ),
  fn("read_file", "Read a text file on the current host.", {
    path: str("path; relative paths use the current directory"),
  }, ["path"]),
  fn(
    "write_file",
    "Create or overwrite a file on the current host with exactly this content (asks the user). Parent directories are created.",
    {
      path: str("path"),
      content: str("full file content"),
      mode: str("octal mode, e.g. 0755"),
    },
    ["path", "content"],
  ),
  fn(
    "ssh",
    "Move to another machine over ssh. ai-bootstrap installs itself there and every tool then runs on that machine until ssh_exit. Hops nest: ssh from a remote host goes one level deeper. Passwords are asked for and remembered by ai-bootstrap; never ask the user for them yourself.",
    {
      destination: str("user@host"),
      port: { type: "integer" },
    },
    ["destination"],
  ),
  fn("ssh_exit", "Leave the current remote host and return to the previous one.", {}),
  fn(
    "plan",
    "Record or update the plan. Pass the whole list each time. Include, as notes on steps, what could go wrong and how you will detect and handle it.",
    {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: str("what to do"),
            status: {
              type: "string",
              enum: ["pending", "in_progress", "done", "failed", "skipped"],
            },
            note: str("risks, checks, or outcome"),
          },
          required: ["step", "status"],
        },
      },
    },
    ["steps"],
  ),
  fn("memory_read", "Read a memory file, fleet.json, or a bundled doc as docs/<name>.", {
    name: str("e.g. local-setup, goals, fleet.json, docs/vllm"),
  }, ["name"]),
  fn(
    "memory_write",
    "Save durable facts about the user's setup. Write INDEX to update the always-visible index (4 kB limit; one line per memory file). Write fleet.json to update the always-visible fleet inventory: the content must be a complete, valid JSON object (it replaces the file; 8 kB limit).",
    {
      name: str("memory name, letters digits - _ ."),
      content: str("Markdown"),
      append: { type: "boolean", description: "append instead of replacing" },
    },
    ["name", "content"],
  ),
  fn(
    "memory_search",
    "Search your memories and the bundled knowledge base (docs on llama.cpp, vLLM, SGLang, Ollama, TensorFold, Ray, mentat, Docker, and per-OS guides to hardware-accelerated models). Returns matching lines as source:line; read a whole doc with memory_read docs/<name>.",
    { query: str("a few keywords, e.g. 'dgx spark vllm' or 'ray multi-node'") },
    ["query"],
  ),
  fn(
    "memory_sync",
    "Sync memory with a private git repository (asks the user), so the setup can be maintained from several machines and survives losing this one. Pass remote_url the first time.",
    { remote_url: str("e.g. git@github.com:you/ai-setup-memory.git; only needed once") },
  ),
  fn("mcp_list", "List MCP servers and their tools.", { server: str("only this server") }),
  fn("mcp_call", "Call a tool on an MCP server.", {
    server: str("server name"),
    tool: str("tool name"),
    arguments: { type: "object", description: "the tool's arguments" },
  }, ["server", "tool"]),
  fn(
    "mcp_add",
    "Add an MCP server to the config (asks the user). Give command+args for a stdio server, or url for an HTTP one.",
    {
      name: str("short name"),
      command: str("executable for a stdio server"),
      args: { type: "array", items: { type: "string" } },
      url: str("URL of a streamable-HTTP server"),
    },
    ["name"],
  ),
  fn(
    "fetch_url",
    "Read a web page or file over HTTP(S) as text, e.g. a recipe or a project's README. GitHub blob links are fetched raw.",
    { url: str("http(s) URL") },
    ["url"],
  ),
  fn(
    "git_clone",
    "Shallow-clone a git repository into a new temporary folder on the current host, without asking the user. Returns the folder, its top-level files and the start of its README; then read files with read_file or run read-only commands there. Use it for recipes, examples and project docs.",
    {
      url: str("https URL (or git@host:org/repo for ssh)"),
      ref: str("branch or tag, default the repository's default branch"),
    },
    ["url"],
  ),
  fn("models_at", "List the models an OpenAI-compatible endpoint serves (GET /models).", {
    base_url: str("e.g. http://10.0.0.5:8000/v1"),
  }, ["base_url"]),
  fn(
    "use_model",
    "Switch to a smarter model once one is reachable (asks the user). The bootstrap model stays as the fallback.",
    {
      base_url: str("OpenAI-compatible base URL ending in /v1"),
      model: str("model id"),
      api_key_env: str("environment variable holding the key, if any"),
      ask_user_for_key: {
        type: "boolean",
        description: "prompt the user for a key, kept in memory only",
      },
    },
    ["base_url", "model"],
  ),
  fn(
    "start_full_model",
    "(Re)start the full model with the start-full script in this machine's startup scripts folder, wait until it answers, and switch to it. The script must run the server in the foreground and contain a line `# endpoint: <base_url> <model>`. If it fails, returns the end of its log and its error lines.",
    {},
    [],
  ),
];

export class Session {
  readonly host: Host;
  stack: Location[] = [];
  plan: PlanStep[] = [];
  private always = new Set<string>();
  /** The full model's start script failed at boot (cleared once it starts). */
  fullFailure: FullFailure | null = null;

  constructor(
    readonly router: Router,
    readonly memory: Memory,
    readonly mcp: McpManager,
    asker: (req: any) => Promise<string | null>,
  ) {
    this.host = new Host(asker, (s) => info(s));
  }

  async init(): Promise<void> {
    this.stack = [{ label: "local", via: [], info: await this.host.info() }];
  }

  get here(): Location {
    return this.stack[this.stack.length - 1];
  }

  where(): string {
    return this.stack.map((l) => l.label).join(" > ");
  }

  private call(op: string, args: unknown): Promise<any> {
    return this.host.handle(op, args, this.here.via);
  }

  private limit(): number {
    return this.router.current().contextChars < 100_000 ? 6000 : 16000;
  }

  private clip(s: string): string {
    const n = this.limit();
    if (s.length <= n) return s;
    return `${s.slice(0, n / 2)}\n...[${s.length - n} chars cut]...\n${s.slice(-n / 2)}`;
  }

  private render(r: ExecResult): string {
    if (r.code !== 0 && !r.stdout.trim() && !r.stderr.trim()) {
      return `exit ${r.code}, no output${
        /\bgrep\b/.test(r.cmd ?? "")
          ? " (grep exits 1 when nothing matches: what you searched for is not in that output; look at it unfiltered, or look elsewhere)"
          : ""
      }`;
    }
    let s = `exit ${r.code}`;
    if (r.cwd) s += ` (cwd now ${r.cwd})`;
    if (r.stdout.trim()) s += `\n${r.stdout.trimEnd()}`;
    if (r.stderr.trim()) s += `\n[stderr]\n${r.stderr.trimEnd()}`;
    return this.clip(s);
  }

  /** Prints what a command printed: the last few lines, so the user can follow along. */
  private show(r: ExecResult): void {
    const lines = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !/^\((stopped by the user|timed out;)/.test(l));
    const tail = lines.slice(-SHOWN_LINES);
    if (lines.length > tail.length) {
      console.log(dim(`    … ${lines.length - tail.length} more lines`));
    }
    for (const l of tail) console.log(dim(`    │ ${l.length > 160 ? `${l.slice(0, 157)}...` : l}`));
    if (r.cancelled) console.log(yellow("    (stopped)"));
    else if (r.timedOut) console.log(red("    (timed out; stopped it and everything it started)"));
    else if (r.code !== 0) console.log(red(`    (exit ${r.code})`));
  }

  /** The user allowed every read-only command for this session. */
  allowReadonly = false;
  readonly classifier = new Classifier(() => this.router.bootstrap);
  private complexTries = new Map<string, number>();

  /**
   * The read-only list, then the bootstrap model's verdict. "complex" twice in a row
   * for the same command is returned at most twice; after that the user decides.
   */
  private async check(cmd: string): Promise<{ verdict: Verdict | null; checked: boolean }> {
    if (isReadonly(cmd)) return { verdict: "readonly", checked: false };
    const verdict = await this.classifier.classify(cmd, this.here.info.osName);
    if (verdict === "complex") {
      const n = (this.complexTries.get(cmd) ?? 0) + 1;
      this.complexTries.set(cmd, n);
      if (n > 2) return { verdict: null, checked: true };
    }
    return { verdict, checked: true };
  }

  private static TOO_COMPLEX =
    "Not run: the safety check could not analyze this command, it is too complex. Rewrite it as smaller steps: one simple command per call, without long pipelines or command lists, loops, inline scripts (python -c, bash -c), eval, here-documents or nested substitutions. To create or edit a file, use write_file.";

  private static label(verdict: Verdict | null, checked: boolean): string {
    if (!checked) return "";
    switch (verdict) {
      case "readonly":
        return dim("  (checked: read-only)");
      case "dangerous":
        return red(bold("  (checked: DANGEROUS)"));
      case "writes":
        return yellow("  (checked: makes changes)");
      default:
        return dim("  (not checked)");
    }
  }

  private async gate(
    what: string,
    key: string,
    kind: ApprovalKind = "normal",
  ): Promise<string | null> {
    if (kind !== "dangerous" && this.always.has(key)) return null;
    const a = await approve(what, kind);
    if (a.always) this.always.add(key);
    if (a.readonly) this.allowReadonly = true;
    if (a.ok) return null;
    return a.note ? `the user declined: ${a.note}` : "the user declined to run this";
  }

  /** Runs a command op on the current host; `signal` cancels it there, across hops too. */
  /** When each command last ran here, and what it returned, to catch a model repeating itself. */
  private recent = new Map<string, { at: number; result: string }>();

  private repeated(key: string): string | null {
    const last = this.recent.get(key);
    if (!last || Date.now() - last.at > REPEAT_WINDOW_MS) return null;
    return `Not run: you ran exactly this a moment ago, and it returned:\n${last.result}\nRunning it again will not change that. Do something different, or ask the user.`;
  }

  private remember(key: string, result: string): string {
    this.recent.set(key, { at: Date.now(), result: result.slice(0, 2000) });
    return result;
  }

  private async command(op: "exec" | "sudo", cmd: string, args: any, signal?: AbortSignal) {
    const token = crypto.randomUUID();
    const via = this.here.via;
    const cancel = () => this.host.handle("cancel", { token }, via).catch(() => {});
    signal?.addEventListener("abort", cancel);
    try {
      const timeoutMs = (Number(args.timeout_s) || DEFAULT_TIMEOUT_MS / 1000) * 1000;
      const r = await this.host.handle(op, { cmd, token, timeoutMs }, via) as ExecResult;
      return { ...r, cmd };
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async exec(name: string, args: any, signal?: AbortSignal): Promise<string> {
    switch (name) {
      case "run": {
        const cmd = String(args.command ?? "");
        const loc = this.where();
        const again = this.repeated(`${loc}\0${cmd}`);
        if (again) {
          console.log(dim(`  [${loc}] $ ${cmd}`));
          console.log(yellow("    not run: the same command again"));
          return again;
        }
        const refused = refuseInRun(cmd);
        if (refused) {
          console.log(dim(`  [${loc}] $ ${cmd}`));
          console.log(yellow(`    not run: ${refused.split(":")[0]}`));
          return `Not run: ${refused}`;
        }
        const { verdict, checked } = await this.check(cmd);
        if (verdict === "complex") {
          console.log(dim(`  [${loc}] $ ${cmd}`));
          console.log(yellow("    too complex to check; asking for smaller steps"));
          return Session.TOO_COMPLEX;
        }
        const label = Session.label(verdict, checked);
        if (verdict === "readonly" && this.allowReadonly) {
          console.log(dim(`  [${loc}] $ ${cmd}`) + label);
        } else {
          const kind = verdict === "readonly"
            ? "readonly"
            : verdict === "dangerous"
            ? "dangerous"
            : "normal";
          const no = await this.gate(`[${bold(loc)}] $ ${cmd}${label}`, `${loc}\0${cmd}`, kind);
          if (no) return no;
        }
        const r = await this.command("exec", cmd, args, signal);
        this.show(r);
        return r.cancelled ? this.render(r) : this.remember(`${loc}\0${cmd}`, this.render(r));
      }
      case "sudo": {
        const cmd = String(args.command ?? "").replace(/^\s*sudo\s+/, "");
        // Root always asks; the check still catches the complex and the dangerous.
        const { verdict, checked } = await this.check(cmd);
        if (verdict === "complex") {
          console.log(dim(`  [${this.where()}] sudo ${cmd}`));
          console.log(yellow("    too complex to check; asking for smaller steps"));
          return Session.TOO_COMPLEX;
        }
        const no = await this.gate(
          `[${bold(this.where())}] ${red("sudo")} ${cmd}${Session.label(verdict, checked)}`,
          `${this.where()}\0sudo\0${cmd}`,
          verdict === "dangerous" ? "dangerous" : "normal",
        );
        if (no) return no;
        const r = await this.command("sudo", cmd, args, signal);
        this.show(r);
        return this.render(r);
      }
      case "read_file": {
        console.log(dim(`  [${this.where()}] read ${args.path}`));
        const r = await this.call("read", { path: String(args.path) });
        if (r.binary) return `${r.path} is binary (${r.size} bytes)`;
        return this.clip(r.content) +
          (r.truncated ? `\n[file is ${r.size} bytes; only the start was read]` : "");
      }
      case "write_file": {
        const content = String(args.content ?? "");
        const preview = content.split("\n").slice(0, 12).map((l) => dim(`    ${l}`)).join("\n");
        const no = await this.gate(
          `[${bold(this.where())}] write ${args.path} (${content.length} bytes${
            args.mode ? `, mode ${args.mode}` : ""
          })\n${preview}`,
          `${this.where()}\0write\0${args.path}\0${content}`,
        );
        if (no) return no;
        const r = await this.call("write", {
          path: String(args.path),
          b64: b64(content),
          mode: args.mode,
        });
        return `wrote ${r.bytes} bytes to ${r.path}`;
      }
      case "ssh": {
        const dest = String(args.destination);
        const no = await this.gate(
          `[${bold(this.where())}] ssh to ${bold(dest)} (ai-bootstrap installs itself there)`,
          `ssh\0${this.where()}\0${dest}`,
        );
        if (no) return no;
        const r = await this.call("ssh_open", { dest, port: args.port });
        const top = this.here;
        this.stack.push({ label: dest, via: [...top.via, r.id], info: r.info });
        console.log(
          green(
            `  now on ${this.where()} (${r.info.os}/${r.info.arch}, ${r.info.user}@${r.info.hostname})`,
          ),
        );
        return `connected. Location: ${this.where()}. ${describe(r.info)}`;
      }
      case "ssh_exit": {
        if (this.stack.length === 1) return "already on the local machine";
        const leaving = this.stack.pop()!;
        await this.host.handle("ssh_close", { id: leaving.via.at(-1) }, this.here.via).catch(
          () => {},
        );
        console.log(green(`  back on ${this.where()}`));
        return `left ${leaving.label}; location is ${this.where()}`;
      }
      case "plan": {
        this.plan = (args.steps ?? []).map((s: any) => ({
          step: String(s.step),
          status: s.status ?? "pending",
          note: s.note,
        }));
        console.log(renderPlan(this.plan));
        return "plan recorded";
      }
      case "memory_read":
        return this.clip(await this.memory.read(String(args.name)));
      case "memory_write": {
        const r = await this.memory.write(
          String(args.name),
          String(args.content ?? ""),
          !!args.append,
        );
        console.log(dim(`  memory: ${r}`));
        return r;
      }
      case "memory_search": {
        const hits = await this.memory.search(String(args.query ?? ""));
        return hits.length
          ? hits.map((h) => `${h.source}:${h.line}: ${h.text}`).join("\n")
          : "no matches; try fewer or different words, or memory_read docs/<name> from the list in the system prompt";
      }
      case "memory_sync": {
        const url = args.remote_url ? String(args.remote_url) : undefined;
        const target = url ?? (await this.memory.remote()) ?? "(not configured)";
        const no = await this.gate(
          `sync memory with ${bold(target)} (git commit, pull, push)`,
          `sync\0${target}`,
        );
        if (no) return no;
        return await this.memory.sync(url);
      }
      case "mcp_list":
        return this.clip(await this.mcp.list(args.server));
      case "mcp_call": {
        console.log(dim(`  mcp ${args.server}.${args.tool}`));
        return this.clip(
          await this.mcp.call(String(args.server), String(args.tool), args.arguments ?? {}),
        );
      }
      case "mcp_add": {
        const cfg = args.url
          ? { url: String(args.url) }
          : { command: String(args.command ?? ""), args: (args.args ?? []).map(String) };
        if (!cfg.url && !(cfg as any).command) return "give either command or url";
        const no = await this.gate(
          `add MCP server ${bold(args.name)}: ${JSON.stringify(cfg)}`,
          `mcp\0${JSON.stringify(cfg)}`,
        );
        if (no) return no;
        await this.mcp.add(String(args.name), cfg);
        return `added; tools:\n${this.clip(await this.mcp.list(String(args.name)))}`;
      }
      case "fetch_url":
        return await this.fetchUrl(String(args.url ?? ""));
      case "git_clone": {
        const url = String(args.url ?? "");
        console.log(dim(`  [${this.where()}] git clone ${url}${args.ref ? ` (${args.ref})` : ""}`));
        const r = await this.call("git_clone", {
          url,
          ref: args.ref ? String(args.ref) : undefined,
        });
        if (r.error) return `clone failed: ${r.error}`;
        return this.clip(
          `cloned into ${r.path}\n\nfiles:\n${r.files.join("\n")}${
            r.readme ? `\n\n${r.readme}` : ""
          }`,
        );
      }
      case "models_at": {
        const base = String(args.base_url).replace(/\/$/, "");
        const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return `HTTP ${r.status}`;
        const j = await r.json();
        const ids = (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
        return ids.length ? this.clip(ids.join("\n")) : "no models listed";
      }
      case "use_model":
        return await this.useModel(args);
      case "start_full_model": {
        if (this.stack.length > 1) {
          return "start_full_model runs on the local machine; ssh_exit back there first";
        }
        const script = scriptPath("full");
        const no = await this.gate(`start the full model with ${bold(script)}`, `full\0${script}`);
        if (no) return no;
        const saved = (await loadSmart()).find((e) => !e.keyInMemory) ?? null;
        const r = await startFull(saved);
        if (!r) return `there is no ${script}; write it first`;
        if ("failure" in r) {
          this.fullFailure = r.failure;
          return `the full model did not start: ${describeFailure(r.failure)}`;
        }
        this.fullFailure = null;
        this.router.setSmart(r.ep);
        await saveSmart(r.ep);
        console.log(green(`  the full model ${r.ep.model} is up; switched to it`));
        return `the full model ${r.ep.model} is answering at ${r.ep.baseUrl}; switched to it.`;
      }
      default:
        return `unknown tool ${name}`;
    }
  }

  private async fetchUrl(raw: string): Promise<string> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return `not a URL: ${raw}`;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "only http and https URLs";
    // github.com/o/r/blob/ref/path -> the raw file, so the model gets text rather than a page.
    const m = url.hostname === "github.com" &&
      url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (m) url = new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`);
    console.log(dim(`  fetch ${url}`));
    const r = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { "user-agent": "ai-bootstrap" },
    });
    const type = r.headers.get("content-type") ?? "";
    if (!r.ok) {
      await r.body?.cancel();
      return `HTTP ${r.status} from ${url}`;
    }
    if (type && !/text|json|xml|yaml|markdown|javascript|toml/.test(type)) {
      await r.body?.cancel();
      return `${url} is ${type}, not text`;
    }
    let text = await r.text();
    if (type.includes("html")) text = htmlToText(text);
    return this.clip(text.trim());
  }

  private async useModel(args: any): Promise<string> {
    const baseUrl = String(args.base_url).replace(/\/$/, "");
    const model = String(args.model);
    const no = await this.gate(
      `switch to ${bold(model)} at ${baseUrl}`,
      `model\0${baseUrl}\0${model}`,
    );
    if (no) return no;
    const ep: Endpoint = {
      label: model,
      baseUrl,
      model,
      keyEnv: args.api_key_env || undefined,
      contextChars: contextFor(sizeFromName(model), /openrouter|openai|anthropic/.test(baseUrl)),
    };
    if (args.ask_user_for_key) {
      const k = await askSecret(`API key for ${baseUrl} (kept in memory only): `);
      if (!k) return "no key given";
      secrets.set([baseUrl], "apikey", k);
      ep.keyInMemory = true;
    }
    try {
      const r = await chat(
        ep,
        [{ role: "user", content: "Reply with the word ok." }],
        [],
        {},
        AbortSignal.timeout(90_000),
      );
      if (!r.content && !r.toolCalls.length) {
        return "the model answered with nothing; not switching";
      }
    } catch (e) {
      return `could not use ${model}: ${(e as Error).message}`;
    }
    this.router.setSmart(ep);
    await saveSmart(ep);
    console.log(
      green(`  now using ${model}; ${this.router.bootstrap.label} stays as the fallback`),
    );
    return `switched to ${model}. The bootstrap model remains the fallback.`;
  }

  async closeAll(): Promise<void> {
    await this.host.closeAll();
    await this.mcp.closeAll();
  }
}

export function describe(i: HostInfo): string {
  return `${i.osName} (${i.os}/${i.arch}), ${i.user}@${i.hostname}, home ${i.home}, shell ${i.shell}, cwd ${i.cwd}`;
}

export function renderPlan(plan: PlanStep[]): string {
  const mark = {
    pending: "○",
    in_progress: yellow("◐"),
    done: green("●"),
    failed: red("✗"),
    skipped: dim("–"),
  };
  return plan.map((s, i) =>
    `  ${mark[s.status] ?? "○"} ${i + 1}. ${s.step}${s.note ? dim(` — ${s.note}`) : ""}`
  ).join("\n") ||
    dim("  (no plan)");
}

const modelsPath = () => join(dataDir(), "models.json");

/** Registered smart models. Never their keys: only the env var names. */
export async function loadSmart(): Promise<Endpoint[]> {
  try {
    return JSON.parse(await Deno.readTextFile(modelsPath())).smart ?? [];
  } catch {
    return [];
  }
}

export async function saveSmart(ep: Endpoint): Promise<void> {
  const all = (await loadSmart()).filter((e) =>
    !(e.baseUrl === ep.baseUrl && e.model === ep.model)
  );
  all.unshift({ ...ep });
  await ensureDir(dataDir());
  await Deno.writeTextFile(
    modelsPath(),
    JSON.stringify({ smart: all.slice(0, 10) }, null, 2) + "\n",
  );
}

/** Re-attaches the most recent smart model that needs no typed-in key. */
export async function restoreSmart(router: Router): Promise<Endpoint | null> {
  for (const ep of await loadSmart()) {
    if (ep.keyInMemory) continue;
    if (ep.keyEnv && !Deno.env.get(ep.keyEnv)) continue;
    if (await reachable(ep)) {
      router.setSmart(ep);
      return ep;
    }
  }
  return null;
}

/** Rough HTML to text: drop scripts, styles and tags; decode the common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}
