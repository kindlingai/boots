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

Deno.test("ssh goes out from the local machine unless hop is asked for", async () => {
  const { Router } = await import("../src/llm.ts");
  const { Memory } = await import("../src/memory.ts");
  const { McpManager } = await import("../src/mcp.ts");
  const { Session } = await import("../src/tools.ts");
  const dir = await Deno.makeTempDir();
  try {
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
      new Memory(`${dir}/mem`),
      new McpManager(`${dir}/mcp.json`),
      () => Promise.resolve(null),
    );
    await s.init();
    const opened: string[] = [];
    const closed: string[] = [];
    let n = 0;
    // No real ssh: record what would be opened from where, and closed.
    (s as any).call = (op: string, a: any) => {
      assertEquals(op, "ssh_open");
      opened.push(`${s.where()} -> ${a.dest}`);
      return Promise.resolve({ id: `c${++n}`, info: { ...s.here.info, hostname: a.dest } });
    };
    (s.host as any).handle = (op: string, a: any) => {
      closed.push(`${op} ${a.id}`);
      return Promise.resolve(null);
    };
    (s as any).always = { has: () => true, add() {} };
    await s.exec("ssh", { destination: "a@one" });
    await s.exec("ssh", { destination: "b@two" });
    assertEquals(s.where(), "local > b@two", "back to local, then out");
    await s.exec("ssh", { destination: "c@three", hop: true });
    assertEquals(s.where(), "local > b@two > c@three", "an explicit hop nests");
    assertEquals(opened, ["local -> a@one", "local -> b@two", "local > b@two -> c@three"]);
    assertEquals(closed, ["ssh_close c1"]);
    assertStringIncludes(await s.exec("ssh", { destination: "a@one" }), "connected");
    assertEquals(s.where(), "local > a@one");
    assertStringIncludes(await s.exec("ssh", { destination: "a@one" }), "already on a@one");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start-full.sh that starts nothing is refused, pointing at use_model", async () => {
  const { refuseStartFull } = await import("../src/tools.ts");
  const remote =
    "#!/bin/sh\n# Starts the full model: qwen on mentat.\n# endpoint: http://192.168.3.7:8000/v1 qwen36-a3b-128k\n";
  assertStringIncludes(refuseStartFull("/x/intelligence/start-full.sh", remote)!, "use_model");
  assertEquals(
    refuseStartFull("C:\\x\\start-full.cmd", "@echo off\r\nrem endpoint: a b\r\n") !== null,
    true,
  );
  assertEquals(
    refuseStartFull("/x/start-full.sh", remote + "exec llama-server -m m.gguf --port 9\n"),
    null,
  );
  assertEquals(refuseStartFull("/x/start-qwen.sh", remote), null, "other scripts are not checked");
});
