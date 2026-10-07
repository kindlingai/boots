// The startup update check: the first repository to answer wins.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assetName,
  checkForUpdate,
  newer,
  parseVersion,
  type Update,
  updateNote,
} from "../src/update.ts";

const release = (repo: string, tag: string): Update => ({
  version: tag.replace(/^v/, ""),
  tag,
  repo,
  url: `https://github.com/${repo}/releases/tag/${tag}`,
});

/** Answers after `ms`, or fails. */
const after = (ms: number, u: Update | Error) => (_r: string, signal: AbortSignal) =>
  new Promise<Update>((ok, fail) => {
    const t = setTimeout(() => (u instanceof Error ? fail(u) : ok(u)), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      fail(new Error("aborted"));
    });
  });

Deno.test("versions compare numerically", () => {
  assertEquals(parseVersion("v0.1.17"), [0, 1, 17]);
  assertEquals(parseVersion("nightly"), null);
  assert(newer("v0.1.18", "0.1.17"));
  assert(newer("0.2.0", "0.1.99"));
  assert(newer("1.0.0", "0.9.9"));
  assert(!newer("0.1.17", "0.1.17"));
  assert(!newer("0.1.9", "0.1.17"), "not compared as strings");
  assert(!newer("junk", "0.1.17"));
});

Deno.test("the first repository to answer wins; a failing one is ignored", async () => {
  const fast = release("kindlingai/boots", "v0.2.0");
  const slow = release("mmastrac/ai-bootstrap", "v0.3.0");
  const by: Record<string, ReturnType<typeof after>> = {
    "mmastrac/ai-bootstrap": after(200, slow),
    "kindlingai/boots": after(10, fast),
  };
  const pick = (r: string, s: AbortSignal) => by[r](r, s);
  assertEquals(await checkForUpdate("0.1.17", Object.keys(by), 1000, pick), fast);

  by["kindlingai/boots"] = after(5, new Error("HTTP 404"));
  assertEquals(await checkForUpdate("0.1.17", Object.keys(by), 1000, pick), slow);
});

Deno.test("no update when up to date, offline, slow or switched off", async () => {
  const same = after(1, release("mmastrac/ai-bootstrap", "v0.1.17"));
  assertEquals(await checkForUpdate("0.1.17", ["a"], 1000, same), null);
  assertEquals(await checkForUpdate("0.1.17", ["a"], 1000, after(1, new Error("offline"))), null);
  const late = after(5000, release("a", "v9.0.0"));
  assertEquals(await checkForUpdate("0.1.17", ["a"], 20, late), null);
  Deno.env.set("AIBOOT_UPDATE_CHECK", "0");
  try {
    assertEquals(
      await checkForUpdate("0.1.17", ["a"], 1000, after(1, release("a", "v9.0.0"))),
      null,
    );
  } finally {
    Deno.env.delete("AIBOOT_UPDATE_CHECK");
  }
});

Deno.test("the prompt note names the version, the package and the upgrade command", () => {
  assertEquals(
    assetName("0.2.0", "x86_64-unknown-linux-gnu"),
    "ai-bootstrap-0.2.0-x86_64-unknown-linux-gnu.tar.gz",
  );
  assertEquals(
    assetName("v0.2.0", "aarch64-apple-darwin"),
    "ai-bootstrap-0.2.0-aarch64-apple-darwin.sh",
  );
  assertEquals(
    assetName("0.2.0", "x86_64-pc-windows-msvc"),
    "ai-bootstrap-0.2.0-x86_64-pc-windows-msvc.zip",
  );
  const u = release("kindlingai/boots", "v0.2.0");
  const note = updateNote(u, "0.1.17", "/opt/bin/ai-bootstrap");
  assertStringIncludes(note, "ai-bootstrap 0.2.0 is out");
  assertStringIncludes(note, "this is 0.1.17");
  // The model runs the upgrade command, which downloads, checks and replaces.
  assertStringIncludes(note, "`/opt/bin/ai-bootstrap upgrade`");
  assertStringIncludes(note, assetName("0.2.0"));
  assertStringIncludes(note, "SHA256SUMS");
  assertStringIncludes(updateNote(u, "0.1.17", "/usr/bin/deno"), "git pull");
});
