// ai-bootstrap upgrade: download, check, and swap the running binary.
import { join } from "@std/path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { upgrade, type UpgradeDeps } from "../src/upgrade.ts";

async function setup(windows = false) {
  const dir = await Deno.makeTempDir();
  const exe = join(dir, windows ? "ai-bootstrap.exe" : "ai-bootstrap");
  await Deno.writeTextFile(exe, "old");
  const asked: string[] = [];
  const later: [string, string][] = [];
  const deps: UpgradeDeps = {
    exe,
    target: windows ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu",
    windows,
    current: "0.1.40",
    log: () => {},
    release: () =>
      Promise.resolve({ version: "0.1.46", tag: "v0.1.46", repo: "kindlingai/boots", url: "" }),
    download: (base, pkg) => {
      asked.push(`${base}/${pkg}`);
      return Promise.resolve(new TextEncoder().encode("new"));
    },
    versionOf: async (p) => (await Deno.readTextFile(p)) === "new" ? "0.1.46" : null,
    later: (from, to) => {
      later.push([from, to]);
      return Promise.resolve();
    },
  };
  return { dir, exe, deps, asked, later };
}

Deno.test("upgrade on Linux/macOS: the checked package replaces the binary in place", async () => {
  const { dir, exe, deps, asked } = await setup();
  try {
    assertStringIncludes(await upgrade(undefined, false, deps), "upgraded 0.1.40 → 0.1.46");
    assertEquals(asked, [
      "https://github.com/kindlingai/boots/releases/download/v0.1.46/ai-bootstrap-0.1.46-x86_64-unknown-linux-gnu.tar.gz",
    ]);
    assertEquals(await Deno.readTextFile(exe), "new");
    assertEquals((await Deno.stat(exe)).mode! & 0o111, 0o111, "executable");
    assertEquals([...Deno.readDirSync(dir)].length, 1, "nothing left beside it");
    // Current already: nothing to do, unless forced.
    deps.current = "0.1.46";
    assertStringIncludes(await upgrade(undefined, false, deps), "already up to date");
    assertStringIncludes(await upgrade(undefined, true, deps), "upgraded");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upgrade on Windows: the running .exe is renamed aside, or replaced after exit", async () => {
  const { dir, exe, deps, asked, later } = await setup(true);
  try {
    assertStringIncludes(await upgrade(undefined, false, deps), "upgraded");
    assert(asked[0].endsWith("x86_64-pc-windows-msvc.zip"));
    assertEquals(await Deno.readTextFile(exe), "new");
    const names = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assert(names.some((n) => /^ai-bootstrap\.old-\d+\.exe$/.test(n)), names.join());
    // When even the rename is refused, a helper moves it in after exit.
    await Deno.remove(exe);
    deps.current = "0.1.40";
    assertStringIncludes(await upgrade(undefined, false, deps), "once ai-bootstrap exits");
    assertEquals(later, [[join(dir, "ai-bootstrap.new.exe"), exe]]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upgrade refuses a binary that does not run as the version it should be", async () => {
  const { dir, exe, deps } = await setup();
  try {
    deps.versionOf = () => Promise.resolve("0.1.45");
    await assertRejects(() => upgrade(undefined, false, deps), Error, "says it is 0.1.45");
    assertEquals(await Deno.readTextFile(exe), "old", "the old one stays");
    assertEquals([...Deno.readDirSync(dir)].length, 1, "the download is removed");
    // From source: nothing to replace.
    deps.exe = "/usr/bin/deno";
    assertStringIncludes(await upgrade(undefined, false, deps), "git pull");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
