// Commands that run without asking: every stage of the pipeline must be a
// known read-only program, with no output redirection or substitution.
// Ported from marsh's heron example.

const READONLY = new Set([
  "cd",
  "pwd",
  "ls",
  "echo",
  "printf",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "find",
  "diff",
  "sort",
  "uniq",
  "cut",
  "tr",
  "comm",
  "which",
  "hostname",
  "uname",
  "whoami",
  "id",
  "df",
  "du",
  "free",
  "uptime",
  "nproc",
  "lscpu",
  "lsblk",
  "lspci",
  "lsusb",
  "stat",
  "file",
  "ps",
  "arch",
  "sw_vers",
  "type",
  "true",
  "test",
  "realpath",
  "dirname",
  "basename",
  "md5sum",
  "sha256sum",
  "groups",
  "getconf",
  "printenv",
  "locale",
  "nl",
  "column",
  "fold",
  "rev",
  "tac",
  "od",
  "xxd",
  "hexdump",
  "strings",
  "cmp",
  "seq",
  "sleep",
  "jq",
  "whereis",
  "readlink",
  "w",
  "who",
  "last",
  "lsof",
  "ss",
  "netstat",
  "lsmod",
  "modinfo",
  "lshw",
  "dmidecode",
  "hwinfo",
  "inxi",
  "rocm-smi",
  "rocminfo",
  "amd-smi",
  "clinfo",
  "vulkaninfo",
  "nvtop",
  "sensors",
  "system_profiler",
  "vm_stat",
  "ioreg",
  "sw_vers",
  "vmstat",
  "iostat",
  "mpstat",
  "getent",
  "lsb_release",
]);

const GIT_READONLY = new Set([
  "show",
  "log",
  "diff",
  "grep",
  "status",
  "blame",
  "shortlog",
  "describe",
  "rev-parse",
  "rev-list",
  "for-each-ref",
  "ls-tree",
  "ls-files",
  "cat-file",
  "diff-tree",
  "diff-files",
  "diff-index",
  "name-rev",
  "help",
  "version",
  "check-attr",
  "check-ignore",
  "verify-commit",
  "verify-tag",
  "merge-base",
  "show-ref",
  "ls-remote",
  "branch",
  "tag",
  "remote",
  "reflog",
  "stash list",
  "stash show",
  "worktree list",
  "remote show",
  "remote get-url",
]);

/** Read-only `<tool> <subcommand>` forms of common infra tools. */
const SUBCOMMANDS: Record<string, Set<string>> = {
  docker: new Set([
    "ps",
    "images",
    "version",
    "info",
    "inspect",
    "logs",
    "image ls",
    "container ls",
    "network ls",
    "volume ls",
  ]),
  podman: new Set(["ps", "images", "version", "info", "inspect", "logs"]),
  systemctl: new Set([
    "status",
    "is-active",
    "is-enabled",
    "is-failed",
    "list-units",
    "list-unit-files",
    "show",
    "cat",
  ]),
  journalctl: new Set(["*"]),
  kubectl: new Set(["get", "describe", "logs", "version", "cluster-info", "top", "api-resources"]),
  ollama: new Set(["list", "ps", "show", "--version", "-v"]),
  pip: new Set(["list", "show", "freeze", "--version"]),
  pip3: new Set(["list", "show", "freeze", "--version"]),
  brew: new Set([
    "list",
    "info",
    "--version",
    "config",
    "--prefix",
    "outdated",
    "doctor",
    "search",
  ]),
  diskutil: new Set(["list", "info", "apfs list"]),
  pmset: new Set(["-g"]),
  launchctl: new Set(["list", "print", "version"]),
  defaults: new Set(["read", "domains"]),
  apt: new Set(["list", "show", "policy", "search"]),
  "apt-cache": new Set(["show", "policy", "search", "depends", "rdepends"]),
  dpkg: new Set(["-l", "-L", "-s", "--list", "--status", "--listfiles", "-S", "--search"]),
  "dpkg-query": new Set(["*"]),
  rpm: new Set(["-q", "-qa", "-qi", "-ql"]),
  dnf: new Set(["list", "info", "search"]),
  snap: new Set(["list", "info"]),
  conda: new Set(["list", "info", "env list", "--version"]),
  nvidia_container_cli: new Set(["info", "--version"]),
  ufw: new Set(["status"]),
  "docker compose": new Set(["ps", "ls", "config", "logs", "images", "version"]),
  huggingface_cli: new Set(["whoami", "env", "scan-cache"]),
  hf: new Set(["auth whoami", "env", "cache scan", "version"]),
  vllm: new Set(["--version", "--help"]),
  lms: new Set(["ls", "ps", "status", "version"]),
  uv: new Set(["--version", "pip list", "pip show", "python list"]),
  cmake: new Set(["--version"]),
  gcc: new Set(["--version", "-v", "-dumpversion", "-dumpmachine"]),
  cc: new Set(["--version", "-v"]),
  clang: new Set(["--version", "-v"]),
  go: new Set(["version", "env"]),
  rustc: new Set(["--version", "-V", "-vV"]),
  cargo: new Set(["--version", "-V"]),
  java: new Set(["-version", "--version"]),
  npm: new Set(["--version", "-v", "ls", "list", "config get"]),
  ruby: new Set(["--version", "-v"]),
  hipcc: new Set(["--version"]),
  hipconfig: new Set(["*"]),
  csrutil: new Set(["status"]),
  hostnamectl: new Set(["", "status", "--static"]),
  timedatectl: new Set(["", "status", "show"]),
  ldconfig: new Set(["-p", "--print-cache"]),
  numactl: new Set(["-H", "--hardware", "-s", "--show"]),
  command: new Set(["-v", "-V"]),
  python3: new Set(["--version", "-V"]),
  python: new Set(["--version", "-V"]),
  node: new Set(["--version", "-v"]),
  deno: new Set(["--version", "-V"]),
  nvcc: new Set(["--version", "-V"]),
};

function onlyFlags(toks: string[], from: number): boolean {
  return toks.slice(from).every((t) => t === "" || t.startsWith("-"));
}

function gitReadonly(toks: string[]): boolean {
  let i = 1;
  while (i < toks.length && toks[i].startsWith("-")) {
    const t = toks[i];
    if (t.startsWith("-c") || t.startsWith("--exec-path") || t.startsWith("--config-env")) {
      return false;
    }
    i++;
    if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(t)) i++;
  }
  if (i >= toks.length) return false;
  const sub = toks[i];
  const two = `${sub} ${toks[i + 1] ?? ""}`.trim();
  if (sub === "config") {
    const bad = [
      "-e",
      "--edit",
      "--add",
      "--unset",
      "--unset-all",
      "--replace-all",
      "--rename-section",
      "--remove-section",
    ];
    const rest = toks.slice(i + 1);
    return !rest.some((t) => bad.includes(t)) && rest.filter((t) => !t.startsWith("-")).length < 2;
  }
  if (sub === "reflog") {
    const first = toks.slice(i + 1).find((t) => !t.startsWith("-"));
    return !first || !["delete", "expire", "write", "drop"].includes(first);
  }
  if (GIT_READONLY.has(two)) return true;
  if (!GIT_READONLY.has(sub)) return false;
  if (["branch", "tag", "remote"].includes(sub)) return onlyFlags(toks, i + 1);
  return true;
}

function stageReadonly(toks: string[]): boolean {
  let head = toks[0];
  if (!head) return true;
  // Leading VAR=value assignments change the environment of the command only.
  while (head && /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
    toks.shift();
    head = toks[0];
  }
  if (!head) return false;
  const seg = toks.join(" ");
  if (head === "docker" && toks[1] === "compose") {
    const a = toks.slice(2).find((t) => !t.startsWith("-")) ?? "";
    return SUBCOMMANDS["docker compose"].has(a);
  }
  if (head === "git") return !seg.includes("--output") && gitReadonly(toks);
  if (head === "find") return !/-exec|-ok|-delete|-fprint|-fls/.test(seg);
  if (head === "sort") {
    return !toks.some((t) => t === "--output" || t.startsWith("--output=") || /^-[^-]*o/.test(t));
  }
  if (head === "hostname") {
    return onlyFlags(toks, 1) && !toks.includes("-s") && !toks.includes("--set");
  }
  if (head === "date") {
    return toks.slice(1).every((t) =>
      t.startsWith("+") || (t.startsWith("-") && !/^-(s|-set)/.test(t))
    );
  }
  // Bare `env` prints; `env X=1 cmd` runs cmd.
  if (head === "env") return onlyFlags(toks, 1);
  if (head === "top") return toks.includes("-b") || toks.includes("-l");
  if (head === "dmesg") {
    return !toks.some((t) => /^(-c|-C|-n|-D|-E|--clear|--read-clear|--console)/.test(t));
  }
  if (head === "lstopo" || head === "lstopo-no-graphics") return onlyFlags(toks, 1);
  // Settings and resets are flags too: allow only the query forms.
  if (head === "nvidia-smi") {
    return toks.slice(1).every((t) =>
      /^(-L|--list-gpus|-q|--query|--query-gpu=.*|--query-compute-apps=.*|--format=.*|-i|--id=.*|-d|--display=.*|topo|-m|nvlink|-s|--status|dmon|pmon|\d+|[A-Z,]+|csv.*|noheader|nounits)$/
        .test(t)
    );
  }
  if (head === "sysctl") return !toks.some((t) => t === "-w" || t.includes("=") || t === "-p");
  if (head === "nvram") return toks.slice(1).every((t) => !t.includes("=") && !/^-(d|c|f)/.test(t));
  if (head === "ip") {
    return !toks.some((t) =>
      /^(set|add|del|delete|flush|change|replace|append|exec|save|restore)$/.test(t)
    );
  }
  const subs = SUBCOMMANDS[head] ?? SUBCOMMANDS[head.replace(/-/g, "_")];
  if (subs) {
    if (subs.has("*")) return !toks.some((t) => /^--(rotate|vacuum|flush|sync|relinquish)/.test(t));
    const a = (toks[1] ?? "").split("=")[0];
    return subs.has(a) || subs.has(`${a} ${toks[2] ?? ""}`.trim());
  }
  return READONLY.has(head);
}

/**
 * Splits a command line into stages (pipeline parts, list items, subshell
 * contents) of unquoted words. null when the line can do more than its words
 * say: command or process substitution, a here-document, a redirect to a
 * file, or an unterminated quote.
 */
export function stages(cmd: string): string[][] | null {
  const out: string[][] = [];
  let words: string[] = [];
  let w = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(w);
    w = "";
    inWord = false;
  };
  const endStage = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  let i = 0;
  const skipSpaces = () => {
    while (cmd[i] === " " || cmd[i] === "\t") i++;
  };
  /** After `>`, `>>` or `&>`: only /dev/null or another descriptor are harmless. */
  const redirectOut = (): boolean => {
    if (cmd[i] === ">") i++;
    if (cmd[i] === "&") {
      i++;
      const m = cmd.slice(i).match(/^(\d+|-)/);
      if (!m) return false;
      i += m[0].length;
      return true;
    }
    if (cmd[i] === "(") return false;
    skipSpaces();
    const m = cmd.slice(i).match(/^[^\s;|&<>()]+/);
    if (!m || m[0] !== "/dev/null") return false;
    i += m[0].length;
    return true;
  };
  for (; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) return null;
      w += cmd.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      inWord = true;
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === "`" || (cmd[i] === "$" && cmd[i + 1] === "(")) return null;
        if (cmd[i] === "\\" && i + 1 < cmd.length) i++;
        w += cmd[i];
      }
      if (i >= cmd.length) return null;
      continue;
    }
    switch (c) {
      case "\\":
        if (i + 1 < cmd.length) w += cmd[++i];
        inWord = true;
        break;
      case "`":
        return null;
      case "$":
        if (cmd[i + 1] === "(") return null;
        w += c;
        inWord = true;
        break;
      case " ":
      case "\t":
        endWord();
        break;
      case ">": {
        // 2>&1, 2>/dev/null: the digits are the descriptor, not a word.
        if (inWord && /^\d+$/.test(w)) {
          w = "";
          inWord = false;
        }
        endWord();
        i++;
        if (!redirectOut()) return null;
        i--;
        break;
      }
      case "<": {
        if (cmd[i + 1] === "(" || cmd[i + 1] === "<") return null;
        // Reading a file is fine; its name is not an argument.
        endWord();
        i++;
        skipSpaces();
        const m = cmd.slice(i).match(/^[^\s;|&<>()]+/);
        if (!m) return null;
        i += m[0].length - 1;
        break;
      }
      case "&":
        if (cmd[i + 1] === ">") {
          endWord();
          i += 2;
          if (!redirectOut()) return null;
          i--;
        } else endStage();
        break;
      case "\n":
      case ";":
      case "|":
      case "(":
      case ")":
        endStage();
        break;
      default:
        w += c;
        inWord = true;
    }
  }
  endStage();
  return out;
}

/** True when every stage of `cmd` can only read. */
export function isReadonly(cmd: string): boolean {
  const st = stages(cmd);
  return !!st && st.length > 0 && st.every(stageReadonly);
}
