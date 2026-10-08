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
  "pgrep",
  "pidof",
  "tree",
  "dig",
  "nslookup",
  "host",
  "zcat",
  "zgrep",
  "xzcat",
  "bzcat",
  "base64",
  "sha1sum",
  "sha512sum",
  "shasum",
  "cksum",
  "md5",
  "ulimit",
  "lsattr",
  "lsns",
  "lslocks",
  "lsipc",
  "findmnt",
  "blkid",
  "nm",
  "objdump",
  "readelf",
  "otool",
  "tty",
  "systemd-detect-virt",
  "virt-what",
  "mdfind",
  "mdls",
]);

/** Hosts a GET request may go to without asking: this machine and private networks. */
function localUrl(u: string): boolean {
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(u) ? u : `http://${u}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host === "::1" || host.endsWith(".local") ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) ||
    (!host.includes(".") && !host.includes(":") && /^[a-z0-9-]+$/i.test(host));
}

/** ssh -o settings that only affect how the connection is made. */
const SSH_SAFE_OPTIONS = new Set(
  `stricthostkeychecking connecttimeout batchmode userknownhostsfile loglevel serveraliveinterval
  serveralivecountmax port user identityfile identitiesonly passwordauthentication
  pubkeyauthentication preferredauthentications connectionattempts addressfamily compression
  hostkeyalgorithms checkhostip`.split(/\s+/),
);

/**
 * ssh that runs a read-only command on the other machine, with only
 * connection options (no tunnels, forwarding, proxy or local commands).
 */
function sshReadonly(toks: string[]): boolean {
  let i = 1;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (!t.startsWith("-")) break;
    if (/^-[TqnxC46vt]+$/.test(t)) continue;
    if (/^-[pil]$/.test(t)) {
      i++;
      continue;
    }
    if (/^-[pil]./.test(t)) continue;
    if (t === "-o" || t.startsWith("-o")) {
      const kv = t === "-o" ? toks[++i] ?? "" : t.slice(2);
      if (!SSH_SAFE_OPTIONS.has(kv.split(/[= ]/)[0].toLowerCase())) return false;
      continue;
    }
    return false;
  }
  const remote = toks.slice(i + 1).join(" ").trim();
  return i < toks.length && remote !== "" && isReadonly(remote);
}

/** curl that only fetches from a local or private address and prints it. */
function curlReadonly(toks: string[]): boolean {
  const safe =
    /^(-[sSfLiIvkg46]+|--(silent|show-error|fail|fail-with-body|location|include|head|verbose|insecure|compressed|globoff|no-progress-meter|ipv4|ipv6|http1\.1|http2))$/;
  const withValue =
    /^(-[mHwAe]|--(max-time|connect-timeout|header|write-out|user-agent|referer|retry|retry-delay|max-redirs|resolve))$/;
  let urls = 0;
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (safe.test(t)) continue;
    if (withValue.test(t)) {
      i++;
      continue;
    }
    if (/^--(max-time|connect-timeout|header|write-out|retry|user-agent)=/.test(t)) continue;
    if (t === "-X" || t === "--request") {
      if (!/^(GET|HEAD)$/i.test(toks[++i] ?? "")) return false;
      continue;
    }
    if (t.startsWith("-")) return false;
    if (!localUrl(t)) return false;
    urls++;
  }
  return urls > 0;
}

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
    "list-timers",
    "list-sockets",
    "list-dependencies",
    "list-jobs",
    "get-default",
    "is-system-running",
    "show-environment",
    "show",
    "cat",
    "--version",
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

export function stageReadonly(toks: string[]): boolean {
  let head = toks[0];
  if (!head) return true;
  // Leading VAR=value assignments change the environment of the command only.
  while (head && /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
    toks.shift();
    head = toks[0];
  }
  if (!head) return false;
  const seg = toks.join(" ");
  // timeout [-s SIG] [-k DUR] DUR cmd...: as read-only as the command it limits.
  if (head === "timeout") {
    let i = 1;
    while (i < toks.length && toks[i].startsWith("-")) {
      i += /^-(s|k|-signal|-kill-after)$/.test(toks[i]) ? 2 : 1;
    }
    return i + 1 < toks.length && /^\d+(\.\d+)?[smhd]?$/.test(toks[i]) &&
      stageReadonly(toks.slice(i + 1));
  }
  // awk that only reads and prints: no system(), no output to a file or a
  // command, no program file and no in-place editing.
  if (/^[gm]?awk$/.test(head)) {
    return !toks.slice(1).some((t) =>
      /system\s*\(|print[^;}]*>|\||^-f|^--file|inplace|^-i$/.test(t)
    );
  }
  // python3 -c with nothing but arithmetic: print(190.3*1.05).
  if (/^python(3(\.\d+)?)?$/.test(head)) return pythonArithmetic(toks);
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
  if (head === "curl") return curlReadonly(toks);
  if (head === "ssh") return sshReadonly(toks);
  if (head === "ping") {
    return toks.some((t) => /^-c\d*$/.test(t)) && !toks.some((t) => /^-f/.test(t));
  }
  if (head === "ifconfig") {
    return toks.length <= 2 &&
      toks.every((t, i) => i === 0 || t === "-a" || !/^(up|down)$/.test(t));
  }
  if (head === "mount") return toks.length === 1;
  if (head === "arp") return toks.slice(1).every((t) => /^-(a|n|an|na)$/.test(t));
  if (head === "route") {
    return toks.slice(1).every((t) => t === "-n" || t === "print") && toks.length > 1;
  }
  if (head === "ulimit") return toks.slice(1).every((t) => /^-[a-zA-Z]+$/.test(t));
  if (head === "smartctl") {
    return toks.slice(1).every((t) =>
      /^(-[aiHAx]+|--(all|info|health|scan|xall)|\/dev\/\S+)$/.test(t)
    );
  }
  if (head === "nvme") {
    return ["list", "smart-log", "id-ctrl", "id-ns", "error-log"].includes(toks[1] ?? "");
  }
  if (head === "scutil") {
    return toks.slice(1).every((t) => /^--(get|dns|proxy|nwi)$/.test(t) || /^[A-Za-z]+$/.test(t)) &&
      !toks.includes("--set");
  }
  if (head === "xcode-select") {
    return toks.slice(1).every((t) => /^(-p|--print-path|-v|--version)$/.test(t));
  }
  if (head === "sysctl") return !toks.some((t) => t === "-w" || t.includes("=") || t === "-p");
  if (head === "nvram") return toks.slice(1).every((t) => !t.includes("=") && !/^-(d|c|f)/.test(t));
  if (head === "ip") {
    return !toks.some((t) =>
      /^(set|add|del|delete|flush|change|replace|append|exec|save|restore)$/.test(t)
    );
  }
  // crontab -l (-u user): lists; anything else installs or removes a crontab.
  if (head === "crontab") return crontabList(toks);
  // systemctl --user is-active x: harmless options before the verb.
  if (head === "systemctl") {
    const opts =
      /^(--user|--system|--no-pager|--no-legend|--plain|--full|-l|--all|-a|-q|--quiet|--failed|--lines=\d+|-n\d*|--output=\w+|-o\w*|--property=[\w,]+|-p[\w,]*|--value|--type=[\w,]+|-t\w*|--state=[\w,]+)$/;
    let i = 1;
    while (i < toks.length && opts.test(toks[i])) i++;
    return SUBCOMMANDS.systemctl.has(toks[i] ?? "");
  }
  const subs = SUBCOMMANDS[head] ?? SUBCOMMANDS[head.replace(/-/g, "_")];
  if (subs) {
    if (subs.has("*")) return !toks.some((t) => /^--(rotate|vacuum|flush|sync|relinquish)/.test(t));
    const a = (toks[1] ?? "").split("=")[0];
    return subs.has(a) || subs.has(`${a} ${toks[2] ?? ""}`.trim());
  }
  return READONLY.has(head);
}

/** crontab -l, optionally for one user (-u name): only lists. */
export function crontabList(toks: string[]): boolean {
  const a = toks.slice(1);
  if (!a.includes("-l")) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "-l") continue;
    if (a[i] === "-u" && a[i + 1] && !a[i + 1].startsWith("-")) {
      i++;
      continue;
    }
    return false;
  }
  return true;
}

/** Names an arithmetic python -c may use. */
const PY_MATH = new Set(
  "print round int float abs min max sum pow divmod len hex bin oct".split(" "),
);

/**
 * python -c "<arithmetic>": numbers, operators, brackets and a few math
 * builtins; no quotes, names, attributes, assignments or imports.
 */
function pythonArithmetic(toks: string[]): boolean {
  if (toks.length !== 3 || toks[1] !== "-c") return false;
  const code = toks[2];
  if (!/^[\w\s.+\-*/%(),]*$/.test(code) || code.includes("__")) return false;
  return (code.match(/[A-Za-z_]\w*/g) ?? []).every((w) => PY_MATH.has(w) || /^e\d*$/.test(w));
}

/**
 * Splits a command line into stages (pipeline parts, list items, subshell
 * contents) of unquoted words. null when the line can do more than its words
 * say: command or process substitution, a here-document, a redirect to a
 * file, or an unterminated quote.
 */
export function stages(cmd: string, depth = 0): string[][] | null {
  const out: string[][] = [];
  /** The stages of command substitutions, checked like the others. */
  const inner: string[][] = [];
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
  /**
   * A substitution starting at i ($(...), `...` or $((...))): its inner
   * command line joins the stages, its text joins the word. False when it
   * does not close, nests too deep, or its inside cannot be split.
   */
  const substitution = (): boolean => {
    if (depth >= 3) return false;
    const start = i;
    let body: string;
    if (cmd[i] === "`") {
      const end = cmd.indexOf("`", i + 1);
      if (end < 0) return false;
      body = cmd.slice(i + 1, end);
      i = end;
    } else {
      // $( ... ) with nesting and quotes; $(( ... )) is arithmetic.
      const arith = cmd[i + 2] === "(";
      let d = 0, j = i + 1, q = "";
      for (; j < cmd.length; j++) {
        const c = cmd[j];
        if (q) {
          if (c === "\\" && q === '"') j++;
          else if (c === q) q = "";
          continue;
        }
        if (c === "'" || c === '"') q = c;
        else if (c === "\\") j++;
        else if (c === "(") d++;
        else if (c === ")" && --d === 0) break;
      }
      if (j >= cmd.length) return false;
      body = cmd.slice(i + (arith ? 3 : 2), arith ? j - 1 : j);
      i = j;
      if (arith) {
        // Arithmetic runs nothing, unless it holds a substitution itself.
        if (/\$\(|`/.test(body)) return false;
        w += cmd.slice(start, i + 1);
        inWord = true;
        return true;
      }
    }
    const st = stages(body, depth + 1);
    if (!st) return false;
    inner.push(...st);
    w += cmd.slice(start, i + 1);
    inWord = true;
    return true;
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
    // /dev/null, or a file in the scratch directory: $BOOTS_SCRATCH/..., or
    // the directory's own path as a machine reported it (no "..").
    const m = cmd.slice(i).match(/^"?(\$\{?BOOTS_SCRATCH\}?\/[A-Za-z0-9._\/-]+)"?|^[^\s;|&<>()]+/);
    if (!m) return false;
    if (m[1]) {
      if (/(^|\/)\.\.(\/|$)/.test(m[1])) return false;
    } else if (m[0] !== "/dev/null" && !inScratchDir(m[0].replace(/^"|"$/g, ""))) return false;
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
        if (cmd[i] === "`" || (cmd[i] === "$" && cmd[i + 1] === "(")) {
          if (!substitution()) return null;
          continue;
        }
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
        if (!substitution()) return null;
        break;
      case "$":
        if (cmd[i + 1] === "(") {
          if (!substitution()) return null;
          break;
        }
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
  return [...out, ...inner];
}

/** True when every stage of `cmd` can only read. */
export function isReadonly(cmd: string): boolean {
  const st = stages(cmd);
  return !!st && st.length > 0 && st.every(stageReadonly);
}

/** The scratch directories of the machines in reach (as each reported its own). */
const scratchDirs = new Set<string>();

/** A machine's scratch directory: redirects into it are not a change. */
export function addScratchDir(dir: string | undefined): void {
  if (dir && dir.startsWith("/") && dir.length > 8) scratchDirs.add(dir.replace(/\/+$/, ""));
}

/** A file path inside one of the known scratch directories (no ".."). */
function inScratchDir(path: string): boolean {
  if (!/^[A-Za-z0-9._\/-]+$/.test(path) || /(^|\/)\.\.(\/|$)/.test(path)) return false;
  for (const d of scratchDirs) {
    if (path.startsWith(d + "/") && path.length > d.length + 1) return true;
  }
  return false;
}

/** What a loop value may contain to be pasted into the body as text. */
const LITERAL = /^[A-Za-z0-9_\-.\/:=@%+, ]+$/;

/** The words of a for list, unquoted; null if one is not a plain literal. */
function literalWords(list: string): string[] | null {
  const out: string[] = [];
  for (const m of list.matchAll(/'([^']*)'|"([^"$`\\]*)"|([^\s'"]+)|(\S)/g)) {
    if (m[4] !== undefined) return null;
    const w = m[1] ?? m[2] ?? m[3];
    if (!LITERAL.test(w) || (m[3] !== undefined && w.includes(" "))) return null;
    out.push(w);
  }
  return out;
}

/**
 * The loop body with `$v` / `${v}` replaced by `value`, as the shell would
 * expand it: unquoted and in double quotes (the value has no characters
 * either context treats specially). null when `$v` is in single quotes,
 * where the shell would not expand it, or the body is not simple.
 */
function substitute(body: string, v: string, value: string): string | null {
  let out = "";
  let q: "" | "'" | '"' = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && q !== "'") {
      out += c + (body[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "'" && q !== '"') q = q ? "" : "'";
    else if (c === '"' && q !== "'") q = q ? "" : '"';
    else if (c === "$") {
      const rest = body.slice(i + 1);
      const m = rest.startsWith(`{${v}}`)
        ? `{${v}}`
        : rest.startsWith(v) && !/[A-Za-z0-9_]/.test(rest[v.length] ?? "")
        ? v
        : null;
      if (m) {
        if (q === "'") return null;
        out += value;
        i += m.length;
        continue;
      }
    }
    out += c;
  }
  return q ? null : out;
}

// A loop may be followed by redirections of its own output (done 2>&1 | tail).
const FOR_LOOP =
  /(^|[;&|(\n]\s*)for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]*?)\s*[;\n]\s*do\s+([\s\S]*?)\s*[;\n]\s*done(?=(?:\s*(?:\d*>&\d+|\d*>\s*\/dev\/null|<\s*\/dev\/null))*\s*(?:$|[;&|)\n]))/;

/** Words that make a loop body more than straight-line commands. */
const BODY_KEYWORDS =
  /(^|[\s;&|(])(for|while|until|do|done|break|continue|select|case|esac|function)(?=$|[\s;&|)])/;

/**
 * `for x in a b c; do cmd $x; done` written out as `cmd a; cmd b; cmd c`, so
 * the safety check sees each command the loop runs. Only loops over plain
 * literal words with a straight-line body are unrolled; anything else (a
 * glob, $(...), nested loops) stays as it was.
 */
export function unrollLoops(cmd: string): string {
  let out = cmd;
  for (let n = 0; n < 4; n++) {
    const m = out.match(FOR_LOOP);
    if (!m) break;
    const [all, lead, v, list, body] = m;
    const words = literalWords(list);
    if (!words?.length || words.length > 32 || BODY_KEYWORDS.test(body)) return cmd;
    const runs: string[] = [];
    for (const w of words) {
      const s = substitute(body, v, w);
      if (s === null) return cmd;
      runs.push(s);
    }
    const start = m.index! + lead.length;
    const alone = start === 0 && m.index! + all.length === out.length;
    const text = alone ? runs.join("; ") : `( ${runs.join("; ")} )`;
    out = out.slice(0, start) + text + out.slice(m.index! + all.length);
    if (out.length > 4000) return cmd;
  }
  return out;
}

/**
 * `bash -c '<script>'` (or sh, zsh, dash, ksh) checked as the script it runs.
 * Only a whole command that is just that: options limited to -e, -u, -x and
 * -o pipefail, the script single-quoted (passed through as written) or
 * double-quoted with nothing the outer shell would expand, and no arguments
 * after it (they would become $0, $1, ... inside). Anything else stays as
 * it was. Nested ones are unwrapped too.
 */
export function unwrapShell(cmd: string): string {
  const SHELL_C =
    /^\s*(?:(?:\/usr)?\/bin\/)?(?:bash|sh|zsh|dash|ksh)((?:\s+(?:-[eux]+|-o\s+pipefail))*)\s+-[eux]*c\s+(?:'([^']*)'|"([^"$`\\]*)")\s*$/;
  let out = cmd;
  for (let n = 0; n < 3; n++) {
    const m = out.match(SHELL_C);
    if (!m) break;
    const script = (m[2] ?? m[3]).trim();
    if (!script) break;
    out = script;
  }
  return out;
}
