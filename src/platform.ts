// Where things live, and which binary runs where.

import { dirname, fromFileUrl, join } from "@std/path";
import denoJson from "../deno.json" with { type: "json" };

export const VERSION: string = denoJson.version;

/** Targets `deno compile` can produce, which are also the remotes we can install on. */
export const TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
] as const;
export type Target = typeof TARGETS[number];

export const isWindows = Deno.build.os === "windows";

export function currentTarget(): string {
  return Deno.build.target;
}

/** Maps `uname -s` / `uname -m` output to a compile target. */
export function targetFromUname(sys: string, machine: string): Target | null {
  const m = machine.trim().toLowerCase();
  const arch = m === "x86_64" || m === "amd64"
    ? "x86_64"
    : m === "aarch64" || m === "arm64"
    ? "aarch64"
    : null;
  if (!arch) return null;
  switch (sys.trim()) {
    case "Linux":
      return `${arch}-unknown-linux-gnu` as Target;
    case "Darwin":
      return `${arch}-apple-darwin` as Target;
    default:
      return null;
  }
}

/** True when running as a `deno compile` executable. */
export function isCompiled(): boolean {
  return import.meta.url.includes("/deno-compile-");
}

function home(): string {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
}

/** Durable state: memories, model and MCP config. Never secrets. */
export function dataDir(): string {
  const o = Deno.env.get("AIBOOT_HOME");
  if (o) return o;
  if (isWindows) {
    return join(Deno.env.get("APPDATA") ?? join(home(), "AppData", "Roaming"), "ai-bootstrap");
  }
  if (Deno.build.os === "darwin") {
    return join(home(), "Library", "Application Support", "ai-bootstrap");
  }
  return join(Deno.env.get("XDG_DATA_HOME") ?? join(home(), ".local", "share"), "ai-bootstrap");
}

/** Durable state that stays on this machine: the data dir, except on Windows, where that roams. */
function localDir(): string {
  if (isWindows && !Deno.env.get("AIBOOT_HOME")) {
    return join(Deno.env.get("LOCALAPPDATA") ?? join(home(), "AppData", "Local"), "ai-bootstrap");
  }
  return dataDir();
}

/** Model weights, shared by the base model and the servers set up for smarter ones. */
export function modelsDir(): string {
  return join(localDir(), "models");
}

/** Scripts that start each model server (start-base.sh for the base model). */
export function scriptsDir(): string {
  return join(localDir(), "intelligence");
}

/** Re-creatable state: downloaded binaries, llama.cpp. */
export function cacheDir(): string {
  const o = Deno.env.get("AIBOOT_CACHE");
  if (o) return o;
  if (isWindows) {
    return join(Deno.env.get("LOCALAPPDATA") ?? join(home(), "AppData", "Local"), "ai-bootstrap");
  }
  if (Deno.build.os === "darwin") return join(home(), "Library", "Caches", "ai-bootstrap");
  return join(Deno.env.get("XDG_CACHE_HOME") ?? join(home(), ".cache"), "ai-bootstrap");
}

/** The shell fragment that computes cacheDir() on a remote unix box. */
export const REMOTE_CACHE_SH =
  `case "$(uname -s)" in Darwin) c="$HOME/Library/Caches/ai-bootstrap";; *) c="\${XDG_CACHE_HOME:-$HOME/.cache}/ai-bootstrap";; esac`;

/** argv that re-runs this program, compiled or not. */
export function selfArgv(): string[] {
  if (isCompiled()) return [Deno.execPath()];
  const main = join(dirname(fromFileUrl(import.meta.url)), "main.ts");
  return [Deno.execPath(), "run", "-A", main];
}

/** The repo's (or the embedded) docs directory. */
export function docsDir(): string {
  return join(dirname(fromFileUrl(import.meta.url)), "..", "docs");
}

export async function ensureDir(p: string): Promise<void> {
  await Deno.mkdir(p, { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * A random free TCP port in 20000-59999, so servers ai-bootstrap starts or
 * suggests never sit on a well-known default (8000, 8080, 11434, ...).
 */
export function randomFreePort(): number {
  for (let i = 0; i < 50; i++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    try {
      Deno.listen({ hostname: "0.0.0.0", port }).close();
      return port;
    } catch {
      // taken
    }
  }
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

let language: { code: string; name: string } | null = null;

/**
 * The user's language, from the locale (LC_ALL, LC_MESSAGES, LANG, else the
 * system's): its code and English name, e.g. { code: "en_US", name: "English" }.
 * A bare C/POSIX locale counts as English.
 */
export function userLanguage(): { code: string; name: string } {
  if (language) return language;
  const env = ["LC_ALL", "LC_MESSAGES", "LANG"].map((k) => Deno.env.get(k) ?? "")
    .find((v) => v && !/^(C|POSIX)(\.|$)/i.test(v));
  let code = (env ?? "").replace(/[.@].*$/, "");
  if (!code) {
    try {
      code = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      code = "en";
    }
  }
  let name = "English";
  try {
    const base = code.split(/[-_]/)[0].toLowerCase();
    name = new Intl.DisplayNames(["en"], { type: "language" }).of(base) ?? "English";
  } catch {
    // unknown code: English
  }
  language = { code: code || "en", name };
  return language;
}

/** The line every prompt carries about the user's language. */
export function languageRule(): string {
  const l = userLanguage();
  return `The user's language is ${l.name} (system locale ${l.code}). Write everything meant for the user in ${l.name}: replies, status lines, goal titles and plans. Do not switch to Chinese or any other language because a tool's output, a document or a model card is in it; change language only if the user writes to you in another one.`;
}
