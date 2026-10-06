// The update check at startup: asks both release repositories for their
// latest release and takes whichever answers first. A newer version adds a
// note to the system prompt so the model offers to update.

import { basename, dirname } from "@std/path";
import { currentTarget, isWindows, VERSION } from "./platform.ts";
import { packageName } from "./package.ts";

// kindlingai/boots is the home now; the old name still redirects there.
export const RELEASE_REPOS = ["kindlingai/boots", "mmastrac/ai-bootstrap"];

export interface Update {
  /** e.g. "0.1.18" */
  version: string;
  tag: string;
  repo: string;
  /** The release page. */
  url: string;
}

/** [major, minor, patch] from "v0.1.17" or "0.1.17"; null if it is not a version. */
export function parseVersion(v: string): number[] | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1, 4).map(Number) : null;
}

/** a > b as versions; false when either is not one. */
export function newer(a: string, b: string): boolean {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The latest release of one repository. Rejects on any failure, so another may win. */
async function latest(repo: string, signal: AbortSignal): Promise<Update> {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
    signal,
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(`${repo}: HTTP ${r.status}`);
  }
  const j = await r.json();
  const tag = String(j.tag_name ?? "");
  if (!parseVersion(tag)) throw new Error(`${repo}: no version in ${tag}`);
  return {
    version: tag.replace(/^v/, ""),
    tag,
    repo,
    url: String(j.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`),
  };
}

/**
 * A release newer than this one, from whichever repository answers first;
 * null when we are up to date, offline, or AIBOOT_UPDATE_CHECK=0.
 */
export async function checkForUpdate(
  current = VERSION,
  repos = RELEASE_REPOS,
  timeoutMs = 5000,
  fetchLatest = latest,
): Promise<Update | null> {
  if (Deno.env.get("AIBOOT_UPDATE_CHECK") === "0") return null;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  try {
    const u = await Promise.any(repos.map((r) => fetchLatest(r, stop.signal)));
    return newer(u.version, current) ? u : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
}

/** The release file of `version` for this platform, as the release workflow names it. */
export function assetName(version: string, target = currentTarget()): string {
  return packageName(target, version);
}

/** The system prompt note: what is newer, and how this install updates. */
export function updateNote(u: Update, current = VERSION, exe = Deno.execPath()): string {
  const asset = assetName(u.version);
  const download = `https://github.com/${u.repo}/releases/download/${u.tag}/${asset}`;
  const compiled = basename(exe).toLowerCase().startsWith("ai-bootstrap");
  const how = !compiled
    ? "This copy runs from source: the user updates it with git pull."
    : `Download ${download} and unpack it so it replaces ${exe} (the .tar.gz holds ai-bootstrap; the macOS .sh writes ai-bootstrap next to itself when run with sh; the .zip holds ai-bootstrap.exe). ${
      isWindows
        ? `Windows will not overwrite a running .exe: rename it first (e.g. to ai-bootstrap.old.exe) in ${
          dirname(exe)
        }. `
        : ""
    }Each command goes through the usual approval. Then the user restarts ai-bootstrap.`;
  return `## Update available

ai-bootstrap ${u.version} is out (${u.url}); this is ${current}. Early in the session, tell the
user in one sentence and offer to update. If they agree: ${how}`;
}
