// The scratch directory, safe writes, and the user's language in prompts.
import { join } from "@std/path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { Host } from "../src/host.ts";
import { inScratch } from "../src/tools.ts";
import { isReadonly } from "../src/readonly.ts";

const unix = Deno.build.os !== "windows";
const b64 = (s: string) => btoa(s);

Deno.test({
  name:
    "write_file never follows a symlink or feeds a pipe; it replaces them, keeping a file's mode",
  ignore: !unix,
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      const h = new Host(() => Promise.resolve(null));
      // A symlink at the path: replaced, its target untouched.
      const target = join(dir, "precious");
      await Deno.writeTextFile(target, "keep me");
      await Deno.symlink(target, join(dir, "link"));
      await h.write(join(dir, "link"), b64("new"));
      assertEquals(await Deno.readTextFile(target), "keep me");
      assertEquals((await Deno.lstat(join(dir, "link"))).isFile, true);
      assertEquals(await Deno.readTextFile(join(dir, "link")), "new");
      // A pipe at the path: replaced by a file, never opened (this would block).
      await new Deno.Command("mkfifo", { args: [join(dir, "pipe")] }).output();
      await h.write(join(dir, "pipe"), b64("x"));
      assertEquals((await Deno.lstat(join(dir, "pipe"))).isFile, true);
      // An existing file keeps its permissions; a directory is refused.
      await Deno.writeTextFile(join(dir, "run.sh"), "old");
      await Deno.chmod(join(dir, "run.sh"), 0o750);
      await h.write(join(dir, "run.sh"), b64("new"));
      assertEquals((await Deno.stat(join(dir, "run.sh"))).mode! & 0o777, 0o750);
      await Deno.mkdir(join(dir, "d"));
      await assertRejects(() => h.write(join(dir, "d"), b64("x")), Error, "is a directory");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "the scratch directory: private, in every command's $BOOTS_SCRATCH, writes checked to land inside",
  ignore: !unix,
  async fn() {
    const h = new Host(() => Promise.resolve(null));
    const s = h.scratch();
    assert(s.startsWith("/tmp/boots-scratch-"));
    assertEquals((await Deno.stat(s)).mode! & 0o777, 0o700);
    const r: any = await h.handle("exec", { cmd: 'echo "$BOOTS_SCRATCH"' }, []);
    assertEquals(r.stdout.trim(), s);
    // $BOOTS_SCRATCH/... in a write is the directory itself.
    const w: any = await h.write("$BOOTS_SCRATCH/notes.txt", b64("hi"), undefined, true);
    assertEquals(w.path, join(s, "notes.txt"));
    // A folder inside that is a symlink out of it is caught.
    const outside = await Deno.makeTempDir();
    try {
      await Deno.symlink(outside, join(s, "escape"));
      await assertRejects(
        () => h.write(join(s, "escape", "x"), b64("x"), undefined, true),
        Error,
        "not inside the scratch directory",
      );
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
    // Which paths count as scratch, before the host's own check.
    assert(inScratch("$BOOTS_SCRATCH/a.txt"));
    assert(inScratch("${BOOTS_SCRATCH}/sub/a.txt"));
    assert(inScratch(`${s}/a.txt`, s));
    assert(!inScratch("$BOOTS_SCRATCH/../etc/passwd"));
    assert(!inScratch("/tmp/other", s));
    assert(!inScratch(s, s), "the directory itself is not a file in it");
    // Commands may send output there and still count as reads.
    assert(isReadonly("docker ps -a > $BOOTS_SCRATCH/ps.txt 2>&1"));
    assert(!isReadonly("ls > $BOOTS_SCRATCH/../x"));
  },
});

Deno.test("every system prompt names the user's language", async () => {
  const { languageRule, userLanguage } = await import("../src/platform.ts");
  const l = userLanguage();
  assert(l.name.length > 1);
  assertStringIncludes(languageRule(), `The user's language is ${l.name}`);
  assertStringIncludes(languageRule(), "Do not switch to Chinese");
  // The locale decides: French from LANG.
  const p = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--config",
      "deno.json",
      'import { userLanguage } from "./src/platform.ts"; console.log(JSON.stringify(userLanguage()))',
    ],
    env: { LANG: "fr_FR.UTF-8", LC_ALL: "", LC_MESSAGES: "" },
  });
  const out = JSON.parse(new TextDecoder().decode((await p.output()).stdout));
  assertEquals(out, { code: "fr_FR", name: "French" });
});
