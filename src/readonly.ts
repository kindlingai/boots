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
  nvidia_smi: new Set(["", "-L", "--list-gpus", "--query-gpu", "-q", "--query"]),
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

function stageReadonly(seg: string): boolean {
  const toks = seg.split(/\s+/).filter(Boolean);
  let head = toks[0];
  if (!head) return true;
  // Leading VAR=value assignments change the environment of the command only.
  while (head && /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
    toks.shift();
    head = toks[0];
  }
  if (!head) return false;
  if (head === "git") return !seg.includes("--output") && gitReadonly(toks);
  if (head === "find") return !/-exec|-ok|-delete|-fprint|-fls/.test(seg);
  if (head === "sort") {
    return !toks.some((t) => t === "--output" || t.startsWith("--output=") || /^-[^-]*o/.test(t));
  }
  if (head === "hostname" || head === "date") {
    return onlyFlags(toks, 1) && !toks.includes("-s") && !toks.includes("--set");
  }
  if (head === "ip") {
    return !toks.some((t) =>
      /^(set|add|del|delete|flush|change|replace|append|exec|save|restore)$/.test(t)
    );
  }
  const subs = SUBCOMMANDS[head.replace(/-/g, "_")];
  if (subs) {
    if (subs.has("*")) return !toks.some((t) => /^--(rotate|vacuum|flush|sync|relinquish)/.test(t));
    const a = (toks[1] ?? "").split("=")[0];
    return subs.has(a) || subs.has(`${a} ${toks[2] ?? ""}`.trim());
  }
  return READONLY.has(head);
}

const HARMLESS_REDIRECTS = [
  "2>>/dev/null",
  "1>>/dev/null",
  "&>>/dev/null",
  ">>/dev/null",
  "2>/dev/null",
  "1>/dev/null",
  "&>/dev/null",
  ">/dev/null",
  "2>&1",
  "1>&2",
  ">&1",
  ">&2",
  "2>&-",
  "1>&-",
];

/** True when every stage of `cmd` can only read. */
export function isReadonly(cmd: string): boolean {
  let s = cmd.replace(/\t/g, " ");
  if (!s.trim()) return false;
  while (s.includes("> ")) s = s.replaceAll("> ", ">");
  for (const j of HARMLESS_REDIRECTS) s = s.replaceAll(j, " ");
  if (/[>$`]/.test(s) || s.includes("<(")) return false;
  const stages = s.split(/&&|\|\||;|\||&|\n/);
  return stages.every((st) => stageReadonly(st.trim()));
}
