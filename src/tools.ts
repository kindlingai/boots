// The tools the model can call, and the session state they act on.

import { tierOf } from "./prompts.ts";
import type { Update } from "./update.ts";
import type { Transcript } from "./transcript.ts";
import { join } from "@std/path";
import { b64, DEFAULT_TIMEOUT_MS, type ExecResult, Host, type HostInfo } from "./host.ts";
import { chat, type Endpoint, reachable, type Router, type ToolDef } from "./llm.ts";
import { type Goal, JSON_MEMORIES, jsonMemory, type Memory } from "./memory.ts";
import type { McpManager } from "./mcp.ts";
import { isReadonly, stages, unrollLoops } from "./readonly.ts";
import {
  describeFailure,
  type FullFailure,
  fullRunning,
  logPath,
  prevLog,
  readLog,
  scriptPath,
  startFull,
} from "./intelligence.ts";
import { secrets } from "./secrets.ts";
import {
  CHARS_PER_TOKEN,
  contextFor,
  declaredContext,
  serverContext,
  sizeFromName,
} from "./discover.ts";
import { dataDir, ensureDir } from "./platform.ts";
import {
  type ApprovalKind,
  approve,
  askSecret,
  bold,
  commandLine,
  cyan,
  dim,
  green,
  info,
  plain as plainText,
  red,
  say,
  spinner,
  yellow,
} from "./ui.ts";
import { Classifier, type Verdict } from "./classify.ts";
import { jsonEval } from "./jsoneval.ts";
import {
  CATALOG,
  describePlan,
  downloads,
  plan,
  removable,
  removeDownloads,
  setUpModel,
} from "./rails.ts";

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
  "timeout",
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
        (i > 0 && WRAPPERS.has(words[i - 1]) && words[i].startsWith("-")) ||
        // timeout's duration
        (i > 0 && words[i - 1] === "timeout" && /^\d+(\.\d+)?[smhd]?$/.test(words[i])))
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
/** Paths whose contents are secrets: reading them as root always asks. */
const SECRET_PATHS =
  /shadow|sudoers|\/\.ssh\/|ssh_host_\w*key|\.(pem|key|p12|pfx|keystore|kdbx)\b|private|secret|token|credential|\.env\b|\/etc\/ssl\/private/i;

export function readsSecrets(cmd: string): boolean {
  return SECRET_PATHS.test(cmd);
}

/** Programs that run something as another user (root, usually). */
const ESCALATE = new Set(["sudo", "doas", "pkexec", "su", "runuser", "run0"]);

/** Programs that run a command given as their arguments. */
const RUNS_ARGS = new Set(["xargs", "watch", "parallel", "flock", "chroot", "unbuffer", "stdbuf"]);

/**
 * True when a command line runs something as root by any route: as a
 * stage, after a wrapper (xargs, watch, find -exec), or inside an inline
 * shell script (sh -c '...', ssh host '...' runs on the other side and
 * is left alone).
 */
export function escalates(cmd: string, depth = 0): boolean {
  if (depth > 3) return false;
  for (const w of commands(cmd)) {
    const head = w[0];
    if (ESCALATE.has(head)) return true;
    if ((RUNS_ARGS.has(head) || head === "find") && w.slice(1).some((t) => ESCALATE.has(t))) {
      return true;
    }
    if (/^(sh|bash|zsh|dash|ksh|fish)$/.test(head)) {
      const c = w.indexOf("-c");
      if (c > 0 && w[c + 1] && escalates(w[c + 1], depth + 1)) return true;
    }
    // ssh host 'sudo ...': root on the other machine, past the sudo tool.
    if (head === "ssh") {
      const remote = sshRemote(w);
      if (remote && escalates(remote, depth + 1)) return true;
    }
  }
  return false;
}

/** The command an ssh invocation runs on the other side ("" for a login shell). */
function sshRemote(words: string[]): string {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "--") return words.slice(i + 2).join(" ");
    if (!w.startsWith("-") || w.length < 2) return words.slice(i + 1).join(" ");
    for (let k = 1; k < w.length; k++) {
      if (!SSH_VALUE_OPTS.includes(w[k])) continue;
      if (k === w.length - 1) i++;
      break;
    }
  }
  return "";
}

/**
 * ssh and root together (`ssh host sudo x`, `sudo ssh host ...`): the advice
 * for doing it the supported way, or null when the line has no such mix.
 */
export function sshRootAdvice(cmd: string): string | null {
  for (const w of commands(cmd)) {
    // sudo ssh ...: connects with root's keys and known_hosts, not the user's.
    let i = 0;
    while (ESCALATE.has(w[i]) || (i > 0 && w[i]?.startsWith("-"))) i++;
    const isSsh = (w[i] ?? "").replace(/^.*\//, "") === "ssh";
    if (i > 0 && isSsh) {
      const dest = sshTargets(w.slice(i).join(" "))[0];
      return `sudo ssh connects with root's ssh keys and known_hosts, not the user's. To work on ${
        dest ?? "that machine"
      }, call the ssh tool with destination ${
        dest ?? "user@host"
      } (no sudo), then use run there, and the sudo tool for anything that needs root on it.`;
    }
    if (w[0] === "ssh") {
      const remote = sshRemote(w);
      if (remote && escalates(remote)) {
        const dest = sshTargets(w.join(" "))[0] ?? "user@host";
        const inner = remote.replace(/^\s*(sudo|doas)(\s+-\S+)*\s+/, "");
        return `root on another machine goes through the tools, so the user approves it and ai-bootstrap handles the password there: call the ssh tool with destination ${dest}, then the sudo tool with command "${inner}" (without the word sudo). Then ssh_exit, or stay for more steps there.`;
      }
    }
  }
  return null;
}

export function refuseInRun(cmd: string): string | null {
  const advice = sshRootAdvice(cmd);
  if (advice) return `ssh with root: ${advice}`;
  const cmds = commands(cmd);
  if (cmds.some((w) => w[0] === "sudo") || escalates(cmd)) {
    return "running as root inside run (sudo, doas, su or pkexec, also inside xargs, find -exec, sh -c or ssh host '...'): use the sudo tool, with the command without the word sudo, so the user approves it; for another machine, connect with the ssh tool first. (Inspection rarely needs root: try it without first.)";
  }
  if (cmds.some(startsServer)) {
    return "this starts a model server, which would block until it times out. Write the command into a start script instead: for the model ai-bootstrap should use, start-full.sh in the startup scripts folder, started with start_full_model. For another server, start-<name>.sh in that machine's startup scripts folder, run in the background with its output to a log: nohup sh <script> > <name>.log 2>&1 &";
  }
  return null;
}

/** ssh options that take a value (the next word, or the rest of the same word). */
const SSH_VALUE_OPTS = "bcDEeFIiJLlmOoPpQRSWw";

/**
 * The machines a command line connects to with ssh, as user@host (user
 * only when given), e.g. `ssh -p 22 admin@gx10 nvidia-smi` -> admin@gx10.
 */
export function sshTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const words of commands(cmd)) {
    if (words[0] !== "ssh") continue;
    let user = "";
    let dest = "";
    for (let i = 1; i < words.length && !dest; i++) {
      const w = words[i];
      if (w === "--") {
        dest = words[i + 1] ?? "";
        break;
      }
      if (!w.startsWith("-") || w.length < 2) {
        dest = w;
        break;
      }
      for (let k = 1; k < w.length; k++) {
        if (!SSH_VALUE_OPTS.includes(w[k])) continue;
        const value = k < w.length - 1 ? w.slice(k + 1) : words[++i] ?? "";
        if (w[k] === "l") user = value;
        break;
      }
    }
    if (!dest) continue;
    let d = dest.replace(/^ssh:\/\//, "");
    if (!d.includes("@") && user) d = `${user}@${d}`;
    // ssh://user@host:port and [v6]:port: the port is not part of the machine.
    if (dest.startsWith("ssh://")) d = d.replace(/:\d+$/, "");
    out.push(d.replace(/^(.*@)?\[(.*)\]$/, "$1$2").toLowerCase());
  }
  return out;
}

/** The host part of a user@host target. */
const sshHost = (t: string) => t.slice(t.lastIndexOf("@") + 1);

/** One line for each tool that does not announce itself. */
const QUIET_TOOLS: Record<string, (a: any) => string> = {
  memory_read: (a) => `reading ${a.name}`,
  memory_search: (a) => `searching memory and docs for "${a.query}"`,
  history_search: (a) => `searching history for "${a.query}"`,
  mcp_list: (a) => a.server ? `listing MCP tools of ${a.server}` : "listing MCP servers",
  fetch_url: (a) => `fetching ${a.url}`,
  models_at: (a) => `listing models at ${a.base_url}`,
};

/** The same command again within this window is not run (the model is going in circles). */
const REPEAT_WINDOW_MS = 60_000;

/** After ^C, how long to wait for a command to stop before giving control back. */
const STOP_WAIT_MS = 3000;

/** Lines of each command's output shown to the user (the model gets more). */
const SHOWN_LINES = 5;

export interface Location {
  label: string;
  via: string[];
  info: HostInfo;
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
    "Move to another machine over ssh. ai-bootstrap installs itself there and every tool then runs on that machine until ssh_exit. The connection goes out from the local machine: if you are on a remote host, ai-bootstrap first leaves it (and any hosts above it) and connects from local. Set hop only when the user explicitly asks to go through the current remote host (multi-hop, e.g. a jump host or a machine on its private network). Passwords are asked for and remembered by ai-bootstrap; never ask the user for them yourself.",
    {
      destination: str("user@host"),
      port: { type: "integer" },
      hop: {
        type: "boolean",
        description:
          "connect from the current remote host instead of from the local machine; only when the user asked for multi-hop",
      },
    },
    ["destination"],
  ),
  fn("ssh_exit", "Leave the current remote host and return to the previous one.", {}),
  fn(
    "update_status",
    "Say in a few words what you are doing now and what is next, e.g. 'TP4 up on 3 of 4 sparks; checking rank 2'. Shown to the user while you work, and kept in your context even when older steps are dropped, so it anchors where you are. Call it often: every few tool calls, and whenever the picture changes.",
    { status: str("one short line, under 100 characters") },
    ["status"],
  ),
  fn(
    "plan",
    "Record or update the plan: the steps of a goal, saved in goals.json (they become the goal's children, and the goal becomes the active one). Pass the whole list each time. Include, as notes on steps, what could go wrong and how you will detect and handle it, and the outcome once known.",
    {
      goal: str(
        "the goal these steps are for (its title): required when no goal is active; otherwise the active goal. A new title adds the goal.",
      ),
      details: str("optional: the goal's details (for you only; never shown to the user)"),
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
  fn(
    "memory_read",
    "Read a memory file, fleet.json, goals.json, or a bundled doc as docs/<name>.",
    {
      name: str("e.g. local-setup, fleet.json, goals.json, docs/vllm"),
    },
    ["name"],
  ),
  fn(
    "memory_write",
    "Save durable facts about the user's setup. Write INDEX to update the always-visible index (4 kB limit; one line per memory file). Write fleet.json to update the always-visible fleet inventory: the content must be a complete, valid JSON object (it replaces the file; 8 kB limit). Write goals.json to replace the always-visible goals: a JSON list of {title, details?, done?, active?, children?}, and nothing else (8 kB limit; details are for you, never shown to the user). For small changes to either, json_eval is easier.",
    {
      name: str("memory name, letters digits - _ ."),
      content: str("Markdown"),
      append: { type: "boolean", description: "append instead of replacing" },
    },
    ["name", "content"],
  ),
  fn(
    "memory_search",
    "Search your memories and the bundled knowledge base (docs on llama.cpp, vLLM, SGLang, Ollama, TensorFold, Ray, mentat, Docker, per-OS guides to hardware-accelerated models, and open model families: Qwen, GLM, Kimi, DeepSeek, Gemma/DiffusionGemma, gpt-oss, Llama/Muse, Mistral, MiniMax, Nemotron, Phi, Granite, OLMo — versions, sizes, memory needs, Hugging Face/GitHub links, serving flags). Returns matching lines as source:line; read a whole doc with memory_read docs/<name>.",
    { query: str("a few keywords, e.g. 'dgx spark vllm' or 'ray multi-node'") },
    ["query"],
  ),
  fn(
    "history_search",
    "Search the conversation log of this and earlier sessions (what the user asked, what you ran and what came back). Lines matching any of the words, best first: rare words (names, paths, hosts) count most, and lines missing some words say how many they matched. Newest first among equals.",
    {
      query: str("a few keywords, e.g. 'vllm port' or 'gx10 ssh'"),
      limit: { type: "number", description: "most lines to return (default 20)" },
    },
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
    "Connect ai-bootstrap itself to a model at an OpenAI-compatible URL (another machine, a mentat router at http://<node>:6381/v1, a hosted API) and use it from now on (asks the user). This is how to switch or reconnect to any model not started by start-full.sh on this machine: check the id with models_at first. It is remembered and reconnected at the next start, so no script is needed; never edit start-full.sh for it. The bootstrap model stays as the fallback.",
    {
      base_url: str("OpenAI-compatible base URL ending in /v1"),
      model: str("model id"),
      api_key_env: str("environment variable holding the key, if any"),
      ask_user_for_key: {
        type: "boolean",
        description: "prompt the user for a key, kept in memory only",
      },
      sampling: {
        type: "object",
        description:
          'optional sampling parameters to send with every request, e.g. {"temperature": 0.7, "top_p": 0.8}. Leave out to use the server\'s defaults (best for most models).',
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

/**
 * For the small base model, every reply must be a tool call (it otherwise
 * announces a step and stops); this is how it talks to the user.
 */
export const REPLY_TOOL = fn(
  "reply",
  "Say something to the user: an answer, a question, or a report that you are done. It ends your turn, so the user can answer. Use the other tools to act; never announce a step here instead of doing it.",
  { message: str("what to say, in plain text") },
  ["message"],
);

export const READ_LOG_TOOL = fn(
  "read_log",
  "Read the end of a model server's log, with the lines that mention errors: full (the full model, latest start), full-previous (the start before that), or bootstrap.",
  {
    log: { type: "string", enum: ["full", "full-previous", "bootstrap"] },
    lines: {
      type: "integer",
      description: "how many lines from the end (default 30, at most 200)",
    },
  },
  ["log"],
);

/** The base model's rails: it sets up a catalog model on this machine, and that is all. */
export const BASE_TOOLS = [
  REPLY_TOOL,
  fn(
    "list_models",
    "List ai-bootstrap's model catalog, best first, marking which models fit this machine's GPU memory. Installs the GPU build of llama.cpp first if needed, to measure the GPU.",
    {},
    [],
  ),
  fn(
    "set_up_model",
    "Set up a catalog model as the full model on this machine and switch to it. The user is asked to confirm. It installs the GPU build of llama.cpp, writes start-full.sh, downloads the model (several GB: this can take many minutes) and starts it. Returns what happened, or the end of the log if it failed.",
    { model: str("a model id from list_models") },
    ["model"],
  ),
  ...TOOLS.filter((t) => t.function.name === "start_full_model"),
  READ_LOG_TOOL,
  fn(
    "remove_downloads",
    "Free disk space: delete unfinished model downloads and catalog models other than `keep`, from ai-bootstrap's models folder. Never the bootstrap model. The user sees the list and confirms.",
    { keep: str("a catalog model id to keep (the one about to be set up), if any") },
    [],
  ),
];

// The full model can manage the local model too (switch it, clean up downloads).
TOOLS.push(
  ...BASE_TOOLS.filter((t) =>
    ["list_models", "set_up_model", "read_log", "remove_downloads"].includes(t.function.name)
  ),
);

TOOLS.push(fn(
  "json_eval",
  "Edit a JSON memory (fleet.json or goals.json) with JavaScript instead of rewriting it. The code runs in a sandbox with no file, network or process access: the current document is the global `json`, your data is the global `input`. Change `json` in place or assign a new value to it; whatever `json` holds when the code ends is saved (if it still matches that memory's shape). console.log output is returned. Example: json.hosts['spark-1'].models.push(input)",
  {
    memory: str("the JSON memory to edit: fleet.json (default) or goals.json"),
    code: str("JavaScript statements (synchronous)"),
    input: { description: "any JSON value, available to the code as `input`" },
  },
  ["code"],
));

export class Session {
  readonly host: Host;
  stack: Location[] = [];
  private always = new Set<string>();
  /** The full model's start script failed at boot (cleared once it starts). */
  fullFailure: FullFailure | null = null;
  /** A newer release, found by the startup check: the prompt asks the model to offer it. */
  update: Update | null = null;
  /** The conversation log (set by main; tests run without one). */
  transcript: Transcript | null = null;

  constructor(
    readonly router: Router,
    readonly memory: Memory,
    readonly mcp: McpManager,
    asker: (req: any) => Promise<string | null>,
  ) {
    this.host = new Host(asker, (s) => info(s));
    this.classifier = new Classifier(
      () => this.router.bootstrapUp() ? this.router.bootstrap : this.router.current(),
      memory.cachePath("classify-cache.json"),
    );
    this.host.onLine = (token, line) => this.lineListeners.get(token)?.(line);
  }

  /** Running commands' latest output, by token (see command()). */
  private lineListeners = new Map<string, (line: string) => void>();

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
      say(dim(`    … ${lines.length - tail.length} more lines`));
    }
    for (const l of tail) say(dim(`    │ ${l.length > 160 ? `${l.slice(0, 157)}...` : l}`));
    if (r.cancelled) say(yellow("    (stopped)"));
    else if (r.timedOut) say(red("    (timed out; stopped it and everything it started)"));
    else if (r.code !== 0) say(red(`    (exit ${r.code})`));
  }

  /** The catalog model our running full model is, if any: its memory counts as free for a switch. */
  private holding(): string | undefined {
    return fullRunning() ? this.router.smart?.model : undefined;
  }

  /**
   * Starts the full model with the local bootstrap stopped (its memory goes to
   * the full model), and brings the bootstrap back if that did not work.
   */
  private async handedOver<T>(start: () => Promise<T>, ok: (r: T) => boolean): Promise<T> {
    await this.router.handover();
    let r: T | undefined;
    try {
      r = await start();
      return r;
    } finally {
      // Not up: the small model takes over (it may never have been started).
      if (r === undefined || !ok(r)) await this.router.ensureBootstrap();
    }
  }

  /** A failed model start, as the user sees it: why, and the end of the log. */
  private showFailure(f: FullFailure): void {
    say(red(`  the full model did not start: ${f.reason}`));
    if (f.cause) say(yellow(`  likely cause: ${f.cause}`));
    for (const l of f.tail) {
      say(dim(`    │ ${l.length > 160 ? `${l.slice(0, 157)}...` : l}`));
    }
    say(dim(`    (log: ${f.log})`));
  }

  /** The user allowed every read-only command for this session. */
  allowReadonly = false;
  // The small model checks commands; while it is handed over, the full model does.
  readonly classifier: Classifier;
  private complexTries = new Map<string, number>();
  /**
   * "auto" (/mode auto) runs read-only commands and non-sudo writes without
   * asking; dangerous ones, sudo and everything else still ask. Never on the
   * small base model.
   */
  mode: "ask" | "auto" = "ask";

  /** Auto mode is on and the model answering may use it. */
  autoActive(): boolean {
    return this.mode === "auto" && tierOf(this.router.current()) !== "base";
  }

  /** Machines already reached with ssh inside run, per location: the next one is refused. */
  private manualSsh = new Set<string>();

  /**
   * The read-only list, then the bootstrap model's verdict. "complex" twice in a row
   * for the same command is returned at most twice; after that the user decides.
   */
  private async check(
    cmd: string,
    root = false,
  ): Promise<{ verdict: Verdict | null; checked: boolean; culprit?: string }> {
    // A loop over literal words is checked as the commands it runs.
    const unrolled = unrollLoops(cmd);
    if (isReadonly(unrolled)) return { verdict: "readonly", checked: false };
    const spin = spinner("checking the command");
    const verdict = await this.classifier.classify(unrolled, this.here.info.osName, root).finally(
      () => spin.stop(),
    );
    if (verdict === "complex") {
      const n = (this.complexTries.get(cmd) ?? 0) + 1;
      this.complexTries.set(cmd, n);
      if (n > 2) return { verdict: null, checked: true };
    }
    // Which part of a line checked stage by stage made it more than read-only.
    const culprit = verdict && verdict !== "readonly"
      ? this.classifier.culprit?.(unrolled)
      : undefined;
    return { verdict, checked: true, culprit };
  }

  private static TOO_COMPLEX =
    "Not run: the safety check could not analyze this command, it is too complex. Rewrite it as smaller steps: one simple command per call, without long pipelines or command lists, loops (a for loop over a fixed list of words is fine), inline scripts (python -c, bash -c), eval, here-documents or nested substitutions. To create or edit a file, use write_file.";

  private static label(verdict: Verdict | null, checked: boolean, culprit?: string): string {
    if (!checked) return "";
    // The part of a longer line that earned the verdict.
    const one = culprit?.replace(/\s+/g, " ");
    const part = one ? `: ${one.length > 80 ? one.slice(0, 79) + "…" : one}` : "";
    switch (verdict) {
      case "readonly":
        return dim("  (checked: read-only)");
      case "dangerous":
        return red(bold(`  (checked: DANGEROUS${part})`));
      case "writes":
        return yellow(`  (checked: makes changes${part})`);
      case "unknown":
        return yellow(`  (runs a script${part}: contents not checked)`);
      default:
        return dim("  (not checked)");
    }
  }

  private async gate(
    what: string,
    key: string,
    kind: ApprovalKind = "normal",
  ): Promise<string | null> {
    // Never remembered for root or anything dangerous: those ask every time.
    if (kind !== "dangerous" && kind !== "root" && this.always.has(key)) return null;
    const a = await approve(what, kind);
    if (a.always && kind !== "dangerous" && kind !== "root") this.always.add(key);
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
    let spin: ReturnType<typeof spinner> | undefined;
    try {
      const timeoutMs = (Number(args.timeout_s) || DEFAULT_TIMEOUT_MS / 1000) * 1000;
      // Something moves while it runs (the frontends add the seconds).
      const short = cmd.replace(/\s+/g, " ");
      const what = `running ${short.length > 50 ? `${short.slice(0, 47)}...` : short}`;
      const s = spin = spinner(what);
      this.lineListeners.set(token, (line) => s.update(`${what}  │ ${line.slice(0, 120)}`));
      const running = this.host.handle(op, { cmd, token, timeoutMs }, via) as Promise<ExecResult>;
      // After ^C, give the command a few seconds to stop, then stop waiting
      // for it: the user gets control back even if it ignores the signal.
      let late: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        running,
        new Promise<ExecResult>((ok) => {
          const giveUp = () =>
            late = setTimeout(() =>
              ok({
                code: 130,
                stdout: "",
                stderr: `(stopped by the user; it did not exit within ${
                  STOP_WAIT_MS / 1000
                }s and may still be running on ${this.where()})`,
                cancelled: true,
              }), STOP_WAIT_MS);
          if (signal?.aborted) giveUp();
          else signal?.addEventListener("abort", giveUp, { once: true });
        }),
      ]);
      clearTimeout(late);
      running.catch(() => {});
      return { ...r, cmd };
    } finally {
      this.lineListeners.delete(token);
      spin?.stop();
      signal?.removeEventListener("abort", cancel);
    }
  }

  async exec(name: string, args: any, signal?: AbortSignal): Promise<string> {
    // Tools that print nothing of their own still show up in the transcript.
    const quiet = QUIET_TOOLS[name];
    if (quiet) say(dim(`  ${quiet(args ?? {})}`));
    switch (name) {
      case "run": {
        const cmd = String(args.command ?? "");
        const loc = this.where();
        const again = this.repeated(`${loc}\0${cmd}`);
        if (again) {
          say(commandLine(loc, "$", cmd));
          say(yellow("    not run: the same command again"));
          return again;
        }
        const refused = refuseInRun(cmd);
        if (refused) {
          say(commandLine(loc, "$", cmd));
          say(yellow(`    not run: ${refused.split(":")[0]}`));
          return `Not run: ${refused}`;
        }
        // One ssh by hand to a machine is fine; a second means it should be a hop.
        const targets = sshTargets(cmd);
        const again2 = targets.find((t) => this.manualSsh.has(`${loc}\0${sshHost(t)}`));
        if (again2) {
          say(commandLine(loc, "$", cmd));
          say(yellow(`    not run: ssh to ${sshHost(again2)} again; use the ssh tool`));
          return `Not run: this is the second command that connects to ${
            sshHost(again2)
          } with ssh inside run. To work on that machine, call the ssh tool with destination ${again2} instead: ai-bootstrap connects once, installs itself there, and run, read_file, write_file and sudo then work on that machine directly (no ssh in the command) until ssh_exit. Passwords are handled for you.`;
        }
        const { verdict, checked, culprit } = await this.check(cmd);
        if (verdict === "complex") {
          say(commandLine(loc, "$", cmd));
          say(yellow("    too complex to check; asking for smaller steps"));
          return Session.TOO_COMPLEX;
        }
        const label = Session.label(verdict, checked, culprit);
        if (verdict === "readonly" && this.allowReadonly) {
          say(commandLine(loc, "$", cmd) + label);
        } else if (this.autoActive() && (verdict === "readonly" || verdict === "writes")) {
          // Auto mode: checked, and not dangerous. (Unchecked commands still ask.)
          say(commandLine(loc, "$", cmd) + label + dim("  (auto)"));
        } else {
          const kind = verdict === "readonly"
            ? "readonly"
            : verdict === "dangerous"
            ? "dangerous"
            : "normal";
          const no = await this.gate(
            `${commandLine(loc, "$", cmd)}${label}`,
            `${loc}\0${cmd}`,
            kind,
          );
          if (no) return no;
        }
        for (const t of targets) this.manualSsh.add(`${loc}\0${sshHost(t)}`);
        const r = await this.command("exec", cmd, args, signal);
        this.show(r);
        return r.cancelled ? this.render(r) : this.remember(`${loc}\0${cmd}`, this.render(r));
      }
      case "sudo": {
        const cmd = String(args.command ?? "").replace(/^\s*sudo\s+/, "");
        // ssh from the sudo tool: root's identity, or root on the far side by
        // a route the user cannot see. Point at ssh first, then sudo there.
        if (commands(cmd).some((w) => w[0] === "ssh")) {
          const advice = sshRootAdvice(`sudo ${cmd}`) ?? sshRootAdvice(cmd);
          say(commandLine(this.where(), "#", cmd));
          say(yellow("    not run: ssh inside sudo; use the ssh tool, then sudo there"));
          return `Not run: ${
            advice ??
              "ssh inside the sudo tool would connect as root. Call the ssh tool to reach the machine, then the sudo tool there."
          }`;
        }
        // Root always asks; the check (told it runs as root) still catches the
        // complex and the dangerous.
        const { verdict, checked, culprit } = await this.check(cmd, true);
        if (verdict === "complex") {
          say(commandLine(this.where(), "#", cmd));
          say(yellow("    too complex to check; asking for smaller steps"));
          return Session.TOO_COMPLEX;
        }
        // Definitely read-only (on the fixed list, not the model's guess) and
        // not reading secrets: runs unasked once the user allows read-only
        // commands; otherwise the prompt offers that.
        const safeRead = !checked && verdict === "readonly" && !readsSecrets(cmd);
        if (safeRead && this.allowReadonly) {
          say(commandLine(this.where(), "#", cmd) + dim("  (read-only)"));
        } else {
          const no = await this.gate(
            `${commandLine(this.where(), "#", cmd)}${Session.label(verdict, checked, culprit)}`,
            `${this.where()}\0sudo\0${cmd}`,
            safeRead ? "readonly" : verdict === "dangerous" ? "dangerous" : "root",
          );
          if (no) return no;
        }
        const r = await this.command("sudo", cmd, args, signal);
        this.show(r);
        return this.render(r);
      }
      case "read_file": {
        say(`${cyan(this.where())} ${dim("read")} ${args.path}`);
        const r = await this.call("read", { path: String(args.path) });
        if (r.binary) return `${r.path} is binary (${r.size} bytes)`;
        return this.clip(r.content) +
          (r.truncated ? `\n[file is ${r.size} bytes; only the start was read]` : "");
      }
      case "write_file": {
        const content = String(args.content ?? "");
        const refused = refuseStartFull(String(args.path ?? ""), content);
        if (refused) return refused;
        const preview = content.split("\n").slice(0, 12).map((l) => dim(`    ${l}`)).join("\n");
        const what = `${cyan(this.where())} write ${
          bold(String(args.path))
        } (${content.length} bytes${args.mode ? `, mode ${args.mode}` : ""})`;
        if (this.autoActive()) {
          say(dim(`  ${plainText(what)}  (auto)`));
        } else {
          const no = await this.gate(
            `${what}\n${preview}`,
            `${this.where()}\0write\0${args.path}\0${content}`,
          );
          if (no) return no;
        }
        const r = await this.call("write", {
          path: String(args.path),
          b64: b64(content),
          mode: args.mode,
        });
        return `wrote ${r.bytes} bytes to ${r.path}`;
      }
      case "ssh": {
        const dest = String(args.destination);
        const hop = args.hop === true && this.stack.length > 1;
        if (!hop && this.stack.length === 2 && this.stack[1].label === dest) {
          return `already on ${dest}. Location: ${this.where()}`;
        }
        const from = hop ? this.where() : this.stack[0].label;
        const no = await this.gate(
          `${commandLine(from, ">>", bold(dest))}${
            hop ? ` ${yellow("(multi-hop, through " + this.here.label + ")")}` : ""
          } (ai-bootstrap installs itself there)`,
          `ssh\0${from}\0${dest}`,
        );
        if (no) return no;
        // Not a hop: go back to the local machine first and connect from there.
        const left: string[] = [];
        while (!hop && this.stack.length > 1) {
          const leaving = this.stack.pop()!;
          await this.host.handle("ssh_close", { id: leaving.via.at(-1) }, this.here.via).catch(
            () => {},
          );
          left.push(leaving.label);
        }
        if (left.length) say(dim(`  left ${left.join(", ")}; connecting from ${this.where()}`));
        const connecting = spinner(`connecting to ${dest}`);
        const r = await this.call("ssh_open", { dest, port: args.port }).catch((e) => {
          throw new Error(
            `${(e as Error).message}${
              left.length ? ` (left ${left.join(", ")} first: now on ${this.where()})` : ""
            }`,
          );
        }).finally(() => connecting.stop());
        const top = this.here;
        this.stack.push({ label: dest, via: [...top.via, r.id], info: r.info });
        say(
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
        say(green(`  back on ${this.where()}`));
        return `left ${leaving.label}; location is ${this.where()}`;
      }
      case "plan": {
        if (!Array.isArray(args.steps)) return "error: steps is required: the whole list of steps";
        const steps = args.steps.map((x: any) => ({
          step: String(x?.step ?? "").trim(),
          status: x?.status ? String(x.status) : undefined,
          note: x?.note === undefined ? undefined : String(x.note),
        })).filter((x: { step: string }) => x.step);
        try {
          const { result, goal } = await this.memory.setPlan(
            steps,
            args.goal ? String(args.goal) : undefined,
            args.details === undefined ? undefined : String(args.details),
          );
          say(renderGoal(goal));
          return `plan recorded under the goal "${goal.title}" in goals.json (${result})`;
        } catch (e) {
          return `plan not recorded: ${(e as Error).message}`;
        }
      }
      case "memory_read":
        return this.clip(await this.memory.read(String(args.name)));
      case "memory_write": {
        const r = await this.memory.write(
          String(args.name),
          String(args.content ?? ""),
          !!args.append,
        );
        say(dim(`  memory: ${r}`));
        return r;
      }
      case "json_eval": {
        const m = jsonMemory(String(args.memory ?? "fleet.json"));
        if (!m) {
          return `json_eval edits JSON memories only: ${
            JSON_MEMORIES.map((j) => j.file).join(", ")
          }`;
        }
        const code = String(args.code ?? "");
        say(dim(`  json_eval ${m.file}: ${code.replace(/\s+/g, " ").slice(0, 100)}`));
        let doc: unknown;
        try {
          doc = JSON.parse((await this.memory.json(m.file)) || m.empty);
        } catch {
          return `${m.file} is not valid JSON now: rewrite it with memory_write first`;
        }
        const r = await jsonEval(doc, args.input ?? null, code);
        const logs = r.logs.length ? `\nconsole output:\n${r.logs.join("\n")}` : "";
        if (r.error) return `not saved: ${r.error}${logs}`;
        const text = JSON.stringify(r.json, null, 2);
        try {
          const saved = await this.memory.write(m.file, text);
          say(dim(`  memory: ${saved}`));
        } catch (e) {
          return `not saved: ${(e as Error).message}${logs}`;
        }
        return `${m.file} saved (${text.length} bytes)${logs}${
          text.length <= 3000 ? `\nnow:\n${text}` : ""
        }`;
      }
      case "memory_search": {
        const hits = await this.memory.search(String(args.query ?? ""));
        return hits.length
          ? hits.map((h) => `${h.source}:${h.line}: ${h.text}`).join("\n")
          : "no matches; try fewer or different words, or memory_read docs/<name> from the list in the system prompt";
      }
      case "history_search": {
        if (!this.transcript) return "no conversation log in this session";
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
        const hits = await this.transcript.search(String(args.query ?? ""), limit);
        return hits.length ? hits.join("\n") : "no matches; try other words (names, paths, hosts)";
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
        say(dim(`  mcp ${args.server}.${args.tool}`));
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
        say(commandLine(this.where(), "$", `git clone ${url}${args.ref ? ` (${args.ref})` : ""}`));
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
        const ids = (j.data ?? j.models ?? []).filter((m: any) => m.id ?? m.name).map((m: any) => {
          const ctx = declaredContext(m);
          return `${m.id ?? m.name}${ctx ? ` (context ${ctx} tokens)` : ""}`;
        });
        return ids.length ? this.clip(ids.join("\n")) : "no models listed";
      }
      case "use_model":
        return await this.useModel(args);
      case "list_models": {
        if (this.stack.length > 1) return "models are set up on the local machine only";
        say(dim("  checking the GPU and the model catalog"));
        return describePlan(await plan(this.here.info.hardware, this.holding()));
      }
      case "remove_downloads": {
        if (this.stack.length > 1) return "models are set up on the local machine only";
        const keep = args.keep ? String(args.keep) : undefined;
        const list = removable(await downloads(), keep);
        if (!list.length) return "nothing to remove: no unfinished or unused catalog downloads";
        const total = list.reduce((n, d) => n + d.bytes, 0);
        const lines = list.map((d) =>
          `    ${(d.bytes / 2 ** 30).toFixed(1)} GB  ${d.path}${d.partial ? " (unfinished)" : ""}`
        );
        const no = await this.gate(
          `delete ${list.length} model download(s), ${(total / 2 ** 30).toFixed(1)} GB:\n${
            lines.join("\n")
          }`,
          `remove\0${list.map((d) => d.path).join("\0")}`,
          "dangerous",
        );
        if (no) return no;
        const gone = await removeDownloads(keep);
        const freed = gone.reduce((n, d) => n + d.bytes, 0);
        say(green(`  freed ${(freed / 2 ** 30).toFixed(1)} GB`));
        return `removed ${gone.length} download(s), ${(freed / 2 ** 30).toFixed(1)} GB freed`;
      }
      case "read_log": {
        const which = String(args.log ?? "full");
        const path = which === "bootstrap"
          ? logPath("bootstrap")
          : which === "full-previous"
          ? prevLog(logPath("full"))
          : logPath("full");
        say(dim(`  read ${path}`));
        return this.clip(await readLog(path, Number(args.lines) || 30));
      }
      case "set_up_model": {
        if (this.stack.length > 1) return "models are set up on the local machine only";
        const id = String(args.model ?? "");
        const m = CATALOG.find((c) => c.id === id);
        if (!m) return `no model ${id}; the catalog has ${CATALOG.map((c) => c.id).join(", ")}`;
        const no = await this.gate(
          `set up ${bold(m.label)} as the full model (~${m.fileGB} GB download)`,
          `setup\0${id}`,
        );
        if (no) return no;
        const r = await this.handedOver(
          () => setUpModel(id, this.here.info.hardware, this.memory, signal, this.holding()),
          (x) => "ep" in x,
        );
        if ("error" in r) {
          if (r.failure) this.showFailure(r.failure);
          else say(red(`  ${r.error.split("\n")[0]}`));
          return r.error;
        }
        this.fullFailure = null;
        this.router.setSmart(r.ep);
        await saveSmart(r.ep);
        say(green(`  ${r.summary}`));
        return `${r.summary} You are now replaced by it: tell the user it is ready, in one sentence.`;
      }
      case "start_full_model": {
        if (this.stack.length > 1) {
          return "start_full_model runs on the local machine; ssh_exit back there first";
        }
        const script = scriptPath("full");
        const no = await this.gate(`start the full model with ${bold(script)}`, `full\0${script}`);
        if (no) return no;
        const saved = (await loadSmart()).find((e) => !e.keyInMemory) ?? null;
        const r = await this.handedOver(
          () => startFull(saved, undefined, signal),
          (x) => !!x && "ep" in x,
        );
        if (!r) return `there is no ${script}; write it first`;
        if ("failure" in r) {
          this.fullFailure = r.failure;
          this.showFailure(r.failure);
          return `the full model did not start: ${describeFailure(r.failure)}`;
        }
        this.fullFailure = null;
        this.router.setSmart(r.ep);
        await saveSmart(r.ep);
        say(green(`  the full model ${r.ep.model} is up; switched to it`));
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
    say(dim(`  fetch ${url}`));
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
      sampling: args.sampling && typeof args.sampling === "object" && !Array.isArray(args.sampling)
        ? args.sampling
        : undefined,
    };
    if (args.ask_user_for_key) {
      const k = await askSecret(`API key for ${baseUrl} (kept in memory only): `);
      if (!k) return "no key given";
      secrets.set([baseUrl], "apikey", k);
      ep.keyInMemory = true;
    }
    // What the server declares beats a guess from the name.
    const ctx = await serverContext(
      baseUrl,
      model,
      ep.keyEnv ? Deno.env.get(ep.keyEnv) : secrets.get([baseUrl], "apikey"),
    );
    if (ctx) ep.contextChars = ctx * CHARS_PER_TOKEN;
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
      return `could not use ${model}: ${
        (e as Error).message
      }. This is the server's error; quote it to the user rather than guessing what kind of model it is.`;
    }
    this.router.setSmart(ep);
    await saveSmart(ep);
    say(
      green(`  now using ${model}; ${this.router.bootstrap.label} stays as the fallback`),
    );
    return `switched to ${model}. The bootstrap model remains the fallback.`;
  }

  async closeAll(): Promise<void> {
    await this.host.closeAll();
    await this.mcp.closeAll();
  }
}

/**
 * start-full.sh must start a server here. A script that only names an
 * endpoint (the model reaching for a remote model) would fail at every start.
 */
export function refuseStartFull(path: string, content: string): string | null {
  if (!/(^|[\\/])start-full\.(sh|cmd)$/i.test(path)) return null;
  const commands = content.split(/\r?\n/).map((l) => l.trim()).filter((l) =>
    l && !l.startsWith("#") && !/^(rem\b|::|@echo off$|set -e\w*$)/i.test(l)
  );
  if (commands.length) return null;
  return "Not written: start-full.sh must run a model server on this machine in the foreground; this one runs nothing, so the full model would fail at every start. To use a model served elsewhere (another machine, mentat, a hosted API), call use_model with its base_url and model instead (models_at lists them). ai-bootstrap remembers it; no script is needed.";
}

export function describe(i: HostInfo): string {
  return `${i.osName} (${i.os}/${i.arch}), ${i.user}@${i.hostname}, home ${i.home}, shell ${i.shell}, cwd ${i.cwd}`;
}

/** A goal and its steps, as the plan tool and /plan show them (details stay hidden). */
export function renderGoal(g: Goal): string {
  const mark = (x: Goal) =>
    x.done
      ? green("●")
      : x.active
      ? yellow("◐")
      : x.details?.startsWith("(failed)")
      ? red("✗")
      : "○";
  const steps = (g.children ?? []).map((c, i) => `  ${mark(c)} ${i + 1}. ${c.title}`);
  return [`${bold(g.title)}`, ...(steps.length ? steps : [dim("  (no steps yet)")])].join("\n");
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
      const ctx = await serverContext(ep.baseUrl, ep.model, ep.keyEnv && Deno.env.get(ep.keyEnv));
      if (ctx) ep.contextChars = ctx * CHARS_PER_TOKEN;
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
