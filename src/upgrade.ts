// `ai-bootstrap upgrade [VERSION] [--force]`: replaces the running binary with
// a release. The package is checked against the release's SHA256SUMS,
// unpacked in-process (tar.gz, the macOS script, or the Windows zip), and the
// new binary must answer --version before it takes the old one's place.
//
// Linux and macOS: written beside the old one and renamed over it (a running
// program keeps its old file until it exits). Windows will not overwrite a
// running .exe but does let it be renamed: the old one is renamed aside and
// the new one moved in; the old one is deleted at the next start. If even the
// rename is refused, a small PowerShell helper waits for this process to end
// and moves the new file in then.

import { basename, dirname, join } from "@std/path";
import { packageName } from "./package.ts";
import { currentTarget, isWindows, VERSION } from "./platform.ts";
import { downloadPackage } from "./ssh.ts";
import { latestRelease, newer, parseVersion, type Update } from "./update.ts";

export interface UpgradeDeps {
  exe: string;
  target: string;
  windows: boolean;
  current: string;
  log: (s: string) => void;
  release: (version?: string) => Promise<Update | null>;
  download: (base: string, pkg: string, log: (s: string) => void) => Promise<Uint8Array>;
  /** The version a binary reports, or null if it does not run. */
  versionOf: (path: string) => Promise<string | null>;
  /** Windows, when the running .exe cannot even be renamed: finish after exit. */
  later: (from: string, to: string) => Promise<void>;
}

/** A specific release, from the first repository that has it. */
async function releaseNamed(version: string): Promise<Update | null> {
  const tag = `v${version.replace(/^v/, "")}`;
  for (const repo of ["kindlingai/boots", "mmastrac/ai-bootstrap"]) {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
      headers: { accept: "application/vnd.github+json" },
    }).catch(() => null);
    if (!r?.ok) {
      await r?.body?.cancel();
      continue;
    }
    const j = await r.json();
    return { version: tag.slice(1), tag, repo, url: String(j.html_url ?? "") };
  }
  return null;
}

async function versionOf(path: string): Promise<string | null> {
  try {
    const o = await new Deno.Command(path, { args: ["--version"], stdout: "piped", stderr: "null" })
      .output();
    const m = new TextDecoder().decode(o.stdout).match(/ai-bootstrap v?(\d+\.\d+\.\d+)/);
    return o.success && m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Waits for this process to exit, then moves the new binary in (Windows). */
function later(from: string, to: string): Promise<void> {
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const script = `Wait-Process -Id ${Deno.pid} -ErrorAction SilentlyContinue; ` +
    `Start-Sleep -Milliseconds 500; Move-Item -Force -LiteralPath ${q(from)} -Destination ${q(to)}`;
  const child = new Deno.Command("powershell", {
    args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  child.unref();
  return Promise.resolve();
}

export function defaultDeps(log: (s: string) => void): UpgradeDeps {
  return {
    exe: Deno.execPath(),
    target: currentTarget(),
    windows: isWindows,
    current: VERSION,
    log,
    release: (v) => v ? releaseNamed(v) : latestRelease(),
    download: downloadPackage,
    versionOf,
    later,
  };
}

/** Runs the upgrade; returns what happened, for the user. Throws on failure. */
export async function upgrade(
  want: string | undefined,
  force: boolean,
  d: UpgradeDeps,
): Promise<string> {
  if (!/^ai-bootstrap/i.test(basename(d.exe))) {
    return `this copy runs from source (${d.exe}): update it with git pull`;
  }
  if (want && !parseVersion(want)) throw new Error(`not a version: ${want}`);
  const rel = await d.release(want);
  if (!rel) {
    throw new Error(
      want ? `no release v${want.replace(/^v/, "")}` : "could not reach the releases",
    );
  }
  if (!force && !newer(rel.version, d.current)) {
    return rel.version === d.current
      ? `already up to date (${d.current})`
      : `${rel.version} is older than this one (${d.current}); pass --force to install it anyway`;
  }
  const pkg = packageName(d.target, rel.version);
  const base = `https://github.com/${rel.repo}/releases/download/${rel.tag}`;
  const bin = await d.download(base, pkg, d.log);

  const dir = dirname(d.exe);
  const fresh = join(dir, d.windows ? "ai-bootstrap.new.exe" : `.${basename(d.exe)}.new`);
  await Deno.writeFile(fresh, bin, { mode: 0o755 });
  try {
    const v = await d.versionOf(fresh);
    if (v !== rel.version) {
      throw new Error(
        v ? `the new binary says it is ${v}, not ${rel.version}` : "the new binary does not run",
      );
    }
    if (!d.windows) {
      await Deno.rename(fresh, d.exe);
      return `upgraded ${d.current} → ${rel.version} (${d.exe}); restart ai-bootstrap to use it`;
    }
    // Windows: the running .exe can be renamed, not replaced.
    const aside = join(dir, `ai-bootstrap.old-${Date.now()}.exe`);
    try {
      await Deno.rename(d.exe, aside);
    } catch {
      await d.later(fresh, d.exe);
      return `downloaded ${rel.version}; it replaces ${d.exe} once ai-bootstrap exits`;
    }
    try {
      await Deno.rename(fresh, d.exe);
    } catch (e) {
      await Deno.rename(aside, d.exe).catch(() => {});
      throw e;
    }
    return `upgraded ${d.current} → ${rel.version} (${d.exe}); restart ai-bootstrap to use it`;
  } catch (e) {
    await Deno.remove(fresh).catch(() => {});
    throw e;
  }
}

/** At start, on Windows: the binaries an upgrade renamed aside. */
export async function cleanUpgradeLeftovers(exe = Deno.execPath()): Promise<void> {
  if (!isWindows) return;
  try {
    for await (const e of Deno.readDir(dirname(exe))) {
      if (/^ai-bootstrap\.old-\d+\.exe$/i.test(e.name)) {
        await Deno.remove(join(dirname(exe), e.name)).catch(() => {});
      }
    }
  } catch {
    // not ours to read
  }
}

/** The CLI: ai-bootstrap upgrade [VERSION] [--force]. */
export async function upgradeMain(args: string[]): Promise<number> {
  const force = args.includes("--force");
  const want = args.find((a) => !a.startsWith("-"));
  try {
    console.log(await upgrade(want, force, defaultDeps((s) => console.log(s))));
    return 0;
  } catch (e) {
    console.error(`upgrade failed: ${(e as Error).message}`);
    return 1;
  }
}
