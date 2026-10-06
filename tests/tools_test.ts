import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { Host } from "../src/host.ts";
import { htmlToText } from "../src/tools.ts";

async function git(cwd: string, ...args: string[]) {
  const o = await new Deno.Command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (o.code !== 0) throw new Error(new TextDecoder().decode(o.stderr));
}

Deno.test("git_clone: shallow clone into a temp folder, with files and README", async () => {
  const src = await Deno.makeTempDir();
  await git(src, "init", "-q", "-b", "main");
  await Deno.writeTextFile(join(src, "README.md"), "# Spark recipe\nRun vLLM on two Sparks.\n");
  await Deno.mkdir(join(src, "configs"));
  await Deno.writeTextFile(join(src, "configs", "a.yaml"), "x: 1\n");
  await git(src, "add", "-A");
  await git(src, "commit", "-q", "-m", "init");
  const h = new Host(() => Promise.resolve(null));
  const r: any = await h.handle("git_clone", { url: toFileUrl(src).href }, []);
  assertEquals(r.error, undefined, r.error);
  assertEquals(r.files, ["README.md", "configs/"]);
  assertStringIncludes(r.readme, "two Sparks");
  assert(r.path.includes("ai-bootstrap-clone-"));
  const bad: any = await h.handle("git_clone", { url: "/etc; rm -rf /" }, []);
  assert(bad.error);
  const missing: any = await h.handle("git_clone", { url: toFileUrl(join(src, "nope")).href }, []);
  assert(missing.error);
});

Deno.test("fetch_url turns HTML into readable text", () => {
  const t = htmlToText(
    "<html><head><style>p{}</style><script>x()</script></head><body><h1>Recipe</h1><p>Use &lt;vllm&gt; &amp; ray</p></body></html>",
  );
  assertStringIncludes(t, "Recipe");
  assertStringIncludes(t, "Use <vllm> & ray");
  assert(!t.includes("x()") && !t.includes("<p>"));
});
