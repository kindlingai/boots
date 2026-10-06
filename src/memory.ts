// Memories about this user's setup, kept as Markdown files in the data
// directory, plus the read-only knowledge docs bundled with ai-bootstrap.
//
// memory/INDEX.md is always in the model's context, so it is capped at 4 kB
// and should hold one-line pointers to the other files.

import { basename, join } from "@std/path";
import { dataDir, docsDir, ensureDir, exists } from "./platform.ts";

export const INDEX_LIMIT = 4096;

const STOPWORDS = new Set([
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
  async isEmpty(): Promise<boolean> {
    const own = (await this.list()).filter((n) => n !== "INDEX" && n !== "local-setup");
    return !own.length && (await this.index()).trim() === SEED.trim();
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
