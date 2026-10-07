// Memories about this user's setup, kept as Markdown files in the data
// directory, plus the read-only knowledge docs bundled with ai-bootstrap.
//
// memory/INDEX.md is always in the model's context, so it is capped at 4 kB
// and should hold one-line pointers to the other files.

import { basename, dirname, join } from "@std/path";
import { dataDir, docsDir, ensureDir, exists } from "./platform.ts";

export const INDEX_LIMIT = 4096;

/** The fleet inventory: always in context, always a valid JSON object. */
export const FLEET = "fleet.json";
export const FLEET_LIMIT = 8192;
/** The user's goals: always in context, a list of {title, details?, done?, active?, children?}. */
export const GOALS = "goals.json";

/** A JSON memory: kept whole, checked on every write, stored pretty-printed. */
interface JsonMemory {
  file: string;
  limit: number;
  /** What reading it gives before anything is written. */
  empty: string;
  /** Why `doc` is not acceptable, or null. */
  check(doc: unknown): string | null;
  /** Where detail should go instead, when it is too big. */
  tooBig: string;
  /** Fixes up a checked document before it is saved. */
  normalize?(doc: unknown): unknown;
}

export interface Goal {
  title: string;
  /** For the model only: how, where, what is known. Never shown to the user. */
  details?: string;
  done?: boolean;
  /** Being worked on now. */
  active?: boolean;
  children?: Goal[];
}

const GOAL_KEYS = ["title", "details", "done", "active", "children"];

/** Why a goals list does not match [{title, details?, done?, active?, children?}], or null. */
export function checkGoals(doc: unknown, at = "goals"): string | null {
  if (!Array.isArray(doc)) {
    return `${at} must be a list of goals: [{"title": "...", "details": "...", "done": false, "active": true, "children": []}]`;
  }
  for (const [i, g] of doc.entries()) {
    const here = `${at}[${i}]`;
    if (g === null || typeof g !== "object" || Array.isArray(g)) {
      return `${here} must be an object with a title`;
    }
    const extra = Object.keys(g).filter((k) => !GOAL_KEYS.includes(k));
    if (extra.length) {
      return `${here} has ${
        extra.join(", ")
      }: a goal has only title, and optionally details, done, active and children`;
    }
    const goal = g as Record<string, unknown>;
    if (typeof goal.title !== "string" || !goal.title.trim()) {
      return `${here}.title must be a non-empty string`;
    }
    for (const k of ["done", "active"]) {
      if (k in goal && typeof goal[k] !== "boolean") return `${here}.${k} must be true or false`;
    }
    if ("details" in goal && typeof goal.details !== "string") {
      return `${here}.details must be a string`;
    }
    if ("children" in goal) {
      const bad = checkGoals(goal.children, `${here}.children`);
      if (bad) return bad;
    }
  }
  return null;
}

/**
 * Goals as saved: a finished goal is no longer active, and when nothing is
 * active the first unfinished top-level goal becomes active.
 */
export function normalizeGoals(goals: Goal[]): Goal[] {
  let any = false;
  const walk = (list: Goal[]) => {
    for (const g of list) {
      if (g.done) delete g.active;
      else if (g.active) any = true;
      else if ("active" in g) delete g.active;
      if (g.children) walk(g.children);
    }
  };
  walk(goals);
  if (!any) {
    const first = goals.find((g) => !g.done);
    if (first) first.active = true;
  }
  return goals;
}

/** The active, unfinished goals, outermost first (parents before their children). */
export function activeGoals(goals: Goal[]): Goal[] {
  const out: Goal[] = [];
  const walk = (list: Goal[]) => {
    for (const g of list) {
      if (g.active && !g.done) out.push(g);
      if (g.children) walk(g.children);
    }
  };
  walk(goals);
  return out;
}

/** Every goal's title, children included. */
export function goalTitles(goals: Goal[]): string[] {
  return goals.flatMap((g) => [g.title, ...goalTitles(g.children ?? [])]);
}

/** Earlier versions kept of each JSON memory. */
const BACKUPS_KEPT = 30;

/** goals.json text as goals; [] when empty or not readable. */
export function parseGoals(text: string): Goal[] {
  try {
    const d = JSON.parse(text || "[]");
    return checkGoals(d) ? [] : d;
  } catch {
    return [];
  }
}

export const JSON_MEMORIES: JsonMemory[] = [
  {
    file: FLEET,
    limit: FLEET_LIMIT,
    empty: "{}",
    check: (d) =>
      d === null || typeof d !== "object" || Array.isArray(d)
        ? 'it must be a JSON object, e.g. {"hosts": {}}'
        : null,
    tooBig: "Keep it to hosts, models and endpoints, and move notes into a separate memory.",
  },
  {
    file: GOALS,
    limit: 8192,
    empty: "[]",
    check: (d) => checkGoals(d),
    normalize: (d) => normalizeGoals(d as Goal[]),
    tooBig:
      "Keep titles short, drop finished goals that no longer matter, and move detail into a separate memory.",
  },
];

/**
 * The JSON memory a name refers to, if any. "fleet" also means fleet.json (it
 * always has); a bare "goals" is still an ordinary memory, as onboarding used
 * to write one.
 */
export function jsonMemory(name: string): JsonMemory | null {
  const n = name === "fleet" ? FLEET : name;
  return JSON_MEMORIES.find((m) => m.file === n) ?? null;
}

export const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "how",
  "do",
  "i",
  "is",
  "it",
  "my",
  "what",
  "which",
  "use",
  "using",
  "set",
  "up",
  "can",
  "should",
  "about",
  "or",
]);

const SEED = `# Memory index

One line per memory file: \`name\` — what it holds. Keep this under 4 kB.

- \`local-setup\` — this machine: OS, CPU/GPU, AI sources found at boot (auto-updated)
`;

export interface Hit {
  source: string;
  line: number;
  text: string;
  score: number;
}

/** Memories ai-bootstrap writes by itself. */
const AUTOMATIC = ["INDEX", "local-setup", "full-model"];

/** Empty, or only full-model entries that set_up_model recorded. */
function automaticFleet(text: string): boolean {
  if (!text.trim()) return true;
  try {
    const f = JSON.parse(text);
    const keys = Object.keys(f ?? {});
    if (!keys.length) return true;
    if (keys.length !== 1 || keys[0] !== "hosts") return false;
    return Object.values(f.hosts ?? {}).every((h: any) =>
      Object.keys(h ?? {}).every((k) => k === "models") &&
      (h.models ?? []).every((m: any) => m?.role === "full model")
    );
  } catch {
    return false;
  }
}

export class Memory {
  readonly dir: string;

  constructor(dir = join(dataDir(), "memory"), readonly docs = docsDir()) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    await ensureDir(this.dir);
    if (!(await exists(this.indexPath()))) await Deno.writeTextFile(this.indexPath(), SEED);
  }

  private indexPath(): string {
    return join(this.dir, "INDEX.md");
  }

  private path(name: string): string {
    const json = jsonMemory(name);
    if (json) return join(this.dir, json.file);
    const n = name.replace(/\.md$/, "");
    if (n === "INDEX") return this.indexPath();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(n)) {
      throw new Error(`bad memory name ${JSON.stringify(name)}: use letters, digits, - _ .`);
    }
    return join(this.dir, `${n}.md`);
  }

  /**
   * True until the user's setup is recorded: no memories besides the
   * automatic local-setup, and INDEX as seeded.
   */
  /**
   * Nothing from the user yet: only what ai-bootstrap records by itself (the
   * local setup, and the full model the base model set up).
   */
  async isEmpty(): Promise<boolean> {
    const own = (await this.list()).filter((n) => !AUTOMATIC.includes(n));
    const index = (await this.index()).split("\n").filter((l) => !/^- full-model:/.test(l))
      .join("\n");
    const goals = (await this.goals()).replace(/\s/g, "");
    return !own.length && automaticFleet(await this.fleet()) && (goals === "" || goals === "[]") &&
      index.trim() === SEED.trim();
  }

  /** fleet.json as stored, or "" when there is none yet. */
  async fleet(): Promise<string> {
    return await this.json(FLEET);
  }

  /** goals.json as stored, or "" when there is none yet. */
  async goals(): Promise<string> {
    return await this.json(GOALS);
  }

  /** A JSON memory as stored, or "" when there is none yet. */
  async json(file: string): Promise<string> {
    return await Deno.readTextFile(join(this.dir, file)).catch(() => "");
  }

  async index(): Promise<string> {
    try {
      return await Deno.readTextFile(this.indexPath());
    } catch {
      return SEED;
    }
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    try {
      for await (const e of Deno.readDir(this.dir)) {
        if (e.isFile && e.name.endsWith(".md")) out.push(e.name.slice(0, -3));
      }
    } catch {
      // no memory folder yet
    }
    return out.sort();
  }

  async docNames(): Promise<string[]> {
    const out: string[] = [];
    try {
      for await (const e of Deno.readDir(this.docs)) {
        if (e.isFile && e.name.endsWith(".md")) out.push(e.name.slice(0, -3));
      }
    } catch {
      // no docs bundled
    }
    return out.sort();
  }

  /** "docs/<name>" reads a bundled doc; anything else is a memory. */
  async read(name: string): Promise<string> {
    if (name.startsWith("docs/")) {
      const n = basename(name.slice(5)).replace(/\.md$/, "");
      try {
        return await Deno.readTextFile(join(this.docs, `${n}.md`));
      } catch {
        throw new Error(`no doc ${n}; available: ${(await this.docNames()).join(", ")}`);
      }
    }
    const json = jsonMemory(name);
    if (json) return (await this.json(json.file)) || `${json.empty}\n`;
    try {
      return await Deno.readTextFile(this.path(name));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new Error(`no memory ${name}; have: ${(await this.list()).join(", ")}`);
      }
      throw e;
    }
  }

  async write(name: string, content: string, append = false): Promise<string> {
    if (name.startsWith("docs/")) throw new Error("docs are read-only; write a memory instead");
    const json = jsonMemory(name);
    if (json) return await this.writeJson(json, content, append);
    const p = this.path(name);
    let next = content;
    if (append) {
      const prev = await Deno.readTextFile(p).catch(() => "");
      next = prev ? `${prev.replace(/\n*$/, "\n")}${content}` : content;
    }
    if (!next.endsWith("\n")) next += "\n";
    const bytes = new TextEncoder().encode(next).length;
    if (p === this.indexPath() && bytes > INDEX_LIMIT) {
      throw new Error(
        `INDEX would be ${bytes} bytes; the limit is ${INDEX_LIMIT}. Move detail into a separate memory file and keep INDEX to one-line pointers.`,
      );
    }
    await Deno.writeTextFile(p, next);
    return `${append ? "appended to" : "wrote"} ${name} (${bytes} bytes)`;
  }

  /** Replaces a JSON memory, after checking it; it is stored pretty-printed. */
  private async writeJson(
    m: JsonMemory,
    content: string,
    append: boolean,
    opts: { clear?: boolean } = {},
  ): Promise<string> {
    if (append) {
      throw new Error(
        `${m.file} cannot be appended to: read it, change it, and write the whole document (or use json_eval)`,
      );
    }
    let doc: unknown;
    try {
      doc = JSON.parse(content);
    } catch (e) {
      throw new Error(
        `${m.file} was not changed: the content is not valid JSON (${(e as Error).message})`,
      );
    }
    const bad = m.check(doc);
    if (bad) throw new Error(`${m.file} was not changed: ${bad}`);
    if (m.normalize) doc = m.normalize(doc);
    const text = JSON.stringify(doc, null, 2) + "\n";
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > m.limit) {
      throw new Error(`${m.file} would be ${bytes} bytes; the limit is ${m.limit}. ${m.tooBig}`);
    }
    const before = await this.json(m.file);
    let removed = "";
    if (m.file === GOALS) {
      const was = goalTitles(parseGoals(before));
      const now = new Set(goalTitles(doc as Goal[]));
      const gone = was.filter((t) => !now.has(t));
      if (was.length && !now.size && !opts.clear) {
        throw new Error(
          `goals.json was not changed: this would remove every goal (${
            was.slice(0, 5).join("; ")
          }). Mark finished goals done instead of deleting them, and keep the rest. Only the user can clear the whole list (/goals clear).`,
        );
      }
      if (gone.length) {
        removed = `; removed ${gone.length} goal${gone.length > 1 ? "s" : ""}: ${
          gone.slice(0, 5).join("; ")
        }${gone.length > 5 ? "; …" : ""} (the previous version is backed up: /goals restore)`;
      }
    }
    if (before && before !== text) await this.backup(m.file, before);
    await Deno.writeTextFile(join(this.dir, m.file), text);
    return `wrote ${m.file} (${bytes} bytes)${removed}`;
  }

  /** A cache file beside the memory folder (not synced, safe to delete). */
  cachePath(name: string): string {
    return join(dirname(this.dir), name);
  }

  /** Where earlier versions of the JSON memories are kept (outside the synced folder). */
  backupDir(): string {
    return `${this.dir}-backups`;
  }

  /** Keeps `text` as an earlier version of `file`; the newest BACKUPS_KEPT stay. */
  private async backup(file: string, text: string): Promise<void> {
    const dir = this.backupDir();
    await ensureDir(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await Deno.writeTextFile(join(dir, `${file}.${stamp}`), text);
    for (const old of (await this.backups(file)).slice(BACKUPS_KEPT)) {
      await Deno.remove(join(dir, old)).catch(() => {});
    }
  }

  /** Backups of `file`, newest first. */
  async backups(file: string): Promise<string[]> {
    const out: string[] = [];
    try {
      for await (const e of Deno.readDir(this.backupDir())) {
        if (e.isFile && e.name.startsWith(`${file}.`)) out.push(e.name);
      }
    } catch {
      // none yet
    }
    return out.sort().reverse();
  }

  /** Empties goals.json at the user's request (backed up first). */
  async clearGoals(): Promise<string> {
    return await this.writeJson(jsonMemory(GOALS)!, "[]", false, { clear: true });
  }

  /**
   * The plan tool: `steps` become the children of a goal in goals.json, the
   * one saved state. The goal is the one titled `goal` (added when there is
   * none), else the active one (with neither, it is refused); it becomes the active goal,
   * and the step in progress its active child. Done and skipped steps are
   * done; notes go into details (a step without a new note keeps its old one).
   */
  async setPlan(
    steps: { step: string; status?: string; note?: string }[],
    goal?: string,
    details?: string,
  ): Promise<{ result: string; goal: Goal }> {
    const goals = parseGoals(await this.json(GOALS));
    normalizeGoals(goals);
    const find = (list: Goal[]): Goal | undefined => {
      for (const g of list) {
        if (goal && g.title.trim().toLowerCase() === goal.trim().toLowerCase()) return g;
        const c = find(g.children ?? []);
        if (c) return c;
      }
    };
    let target = goal ? find(goals) : activeGoals(goals).find((g) => goals.includes(g)) ??
      activeGoals(goals)[0];
    if (!target) {
      // A step's text makes a poor goal: ask for the goal by name.
      if (!goal?.trim()) {
        throw new Error(
          'no goal is active, so name the one these steps serve: pass goal (a short title of what the user wants, e.g. "Serve GLM-5.3 on the four GX10s") and details (what you know so far)',
        );
      }
      target = { title: goal.trim() };
      goals.push(target);
    }
    if (details !== undefined) target.details = details;
    const old = new Map((target.children ?? []).map((c) => [c.title, c]));
    target.children = steps.map((st) => {
      const prev = old.get(st.step);
      const status = st.status ?? "pending";
      const mark = status === "failed" ? "(failed) " : status === "skipped" ? "(skipped) " : "";
      const note = st.note ?? prev?.details?.replace(/^\((failed|skipped)\) /, "");
      const child: Goal = { ...prev, title: st.step };
      delete child.active;
      delete child.done;
      if (note || mark) child.details = `${mark}${note ?? ""}`.trim();
      else delete child.details;
      if (status === "done" || status === "skipped") child.done = true;
      if (status === "in_progress") child.active = true;
      return child;
    });
    // Working on this goal now: the others step back.
    const clear = (list: Goal[]) => {
      for (const g of list) {
        if (g !== target && !target!.children!.includes(g)) delete g.active;
        clear(g.children ?? []);
      }
    };
    clear(goals);
    target.active = true;
    // Every step done finishes the goal; an open step reopens it.
    if (target.children.length) {
      if (target.children.every((c) => c.done)) target.done = true;
      else delete target.done;
    }
    const result = await this.writeJson(jsonMemory(GOALS)!, JSON.stringify(goals), false);
    return { result, goal: target };
  }

  /**
   * Puts back the newest backup of goals.json that has goals in it, keeping
   * the current version as a backup too. Null when there is none.
   */
  async restoreGoals(): Promise<{ titles: string[]; from: string } | null> {
    const current = await this.json(GOALS);
    for (const b of await this.backups(GOALS)) {
      const text = await Deno.readTextFile(join(this.backupDir(), b)).catch(() => "");
      const goals = parseGoals(text);
      if (!goals.length || text === current) continue;
      await this.writeJson(jsonMemory(GOALS)!, text, false, { clear: true });
      return { titles: goals.map((g) => g.title), from: b.slice(GOALS.length + 1) };
    }
    return null;
  }

  /**
   * Searches memories and the bundled knowledge base. Terms match at word
   * starts ("gpu" finds "GPUs", "ray" does not find "array"); a file whose
   * name matches a term is listed first, and each file contributes at most
   * three lines.
   */
  async search(query: string, limit = 10): Promise<Hit[]> {
    const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9.+_-]+/))]
      .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
      .filter((t) => t.length > 1 && !STOPWORDS.has(t));
    if (!terms.length) return [];
    const res = terms.map((t) =>
      new RegExp(`(?<![a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")
    );
    const files: [string, string][] = [];
    for (const n of await this.list()) files.push([n, join(this.dir, `${n}.md`)]);
    for (const m of JSON_MEMORIES) {
      if (await this.json(m.file)) files.push([m.file, join(this.dir, m.file)]);
    }
    for (const n of await this.docNames()) files.push([`docs/${n}`, join(this.docs, `${n}.md`)]);
    const hits: Hit[] = [];
    for (const [source, p] of files) {
      const text = await Deno.readTextFile(p).catch(() => "");
      const lines = text.split("\n");
      const name = source.replace(/^docs\//, "").replace(/[-_.]/g, " ");
      const named = res.filter((r) => r.test(name)).length;
      // One entry per line; a doc whose name matches gets its title line boosted.
      const mine = new Map<number, Hit>();
      if (named) {
        const at = Math.max(0, lines.findIndex((l) => l.startsWith("# ")));
        mine.set(at, {
          source,
          line: at + 1,
          text: (lines[at] ?? "").trim().slice(0, 200),
          score: 3 * named + 1,
        });
      }
      lines.forEach((line, i) => {
        const matched = res.filter((r) => r.test(line)).length;
        if (!matched) return;
        const score = matched * 2 + (line.startsWith("#") ? 1 : 0) + named * 0.5;
        const prev = mine.get(i);
        if (!prev || prev.score < score) {
          mine.set(i, { source, line: i + 1, text: line.trim().slice(0, 200), score });
        }
      });
      hits.push(...[...mine.values()].sort((x, y) => y.score - x.score).slice(0, 3));
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Rewrites the auto-generated part of local-setup, keeping anything below it. */
  async recordLocalSetup(facts: string): Promise<void> {
    const p = this.path("local-setup");
    const marker = "<!-- notes below are kept across boots -->";
    const prev = await Deno.readTextFile(p).catch(() => "");
    const notes = prev.includes(marker) ? prev.slice(prev.indexOf(marker) + marker.length) : "\n";
    await Deno.writeTextFile(
      p,
      `# Local setup (auto-updated at boot)\n\n${facts.trim()}\n\n${marker}${notes}`,
    );
  }

  // ---- sync to a private git repository --------------------------------

  private async git(args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
    try {
      const o = await new Deno.Command("git", {
        // Memories are LF text everywhere; Windows' autocrlf would rewrite them.
        args: ["-c", "core.autocrlf=false", ...args],
        cwd: this.dir,
        env: { GIT_TERMINAL_PROMPT: "0" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(timeoutMs),
      }).output();
      const d = new TextDecoder();
      return { code: o.code, out: (d.decode(o.stdout) + d.decode(o.stderr)).trim() };
    } catch (e) {
      return { code: 127, out: (e as Error).message };
    }
  }

  /** The sync remote, or null when memory is not synced. */
  async remote(): Promise<string | null> {
    if (!(await exists(join(this.dir, ".git")))) return null;
    const r = await this.git(["remote", "get-url", "origin"]);
    return r.code === 0 ? r.out : null;
  }

  /** Commits local changes, rebases onto the remote, and pushes. */
  async sync(remoteUrl?: string): Promise<string> {
    if ((await this.git(["--version"])).code !== 0) throw new Error("git is not installed");
    if (!(await exists(join(this.dir, ".git")))) {
      if (!remoteUrl) {
        throw new Error("memory is not synced yet: give the URL of a private git repository");
      }
      await this.must(["init", "-q", "-b", "main"]);
    }
    if (remoteUrl) {
      const has = (await this.git(["remote", "get-url", "origin"])).code === 0;
      await this.must(["remote", has ? "set-url" : "add", "origin", remoteUrl]);
    }
    const who = (await this.git(["config", "user.email"])).out
      ? []
      : ["-c", "user.name=ai-bootstrap", "-c", "user.email=ai-bootstrap@localhost"];
    await this.must(["add", "-A"]);
    const dirty = (await this.git(["diff", "--cached", "--quiet"])).code !== 0;
    if (dirty) await this.must([...who, "commit", "-q", "-m", `memory from ${Deno.hostname()}`]);
    const fetched = await this.git(["fetch", "-q", "origin"]);
    if (fetched.code !== 0) throw new Error(`git fetch failed: ${fetched.out}`);
    if ((await this.git(["rev-parse", "--verify", "-q", "origin/main"])).code === 0) {
      const hasLocal = (await this.git(["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
      const r = hasLocal
        ? await this.git([...who, "rebase", "-q", "origin/main"])
        : await this.git(["reset", "-q", "--hard", "origin/main"]);
      if (r.code !== 0) {
        await this.git(["rebase", "--abort"]);
        throw new Error(`could not merge the remote memory: ${r.out}`);
      }
    }
    if ((await this.git(["rev-parse", "--verify", "-q", "HEAD"])).code !== 0) {
      return "nothing to sync yet";
    }
    const push = await this.git(["push", "-q", "-u", "origin", "main"]);
    if (push.code !== 0) throw new Error(`git push failed: ${push.out}`);
    return `memory synced with ${await this.remote()}${dirty ? " (local changes pushed)" : ""}`;
  }

  /** At boot: bring in changes made from other machines. Quiet on failure. */
  async pull(): Promise<string | null> {
    const remote = await this.remote();
    if (!remote) return null;
    try {
      return await this.sync();
    } catch (e) {
      return `memory sync with ${remote} failed: ${(e as Error).message}`;
    }
  }

  private async must(args: string[]): Promise<void> {
    const r = await this.git(args);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out}`);
  }
}
