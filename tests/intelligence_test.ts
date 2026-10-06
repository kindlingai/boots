// Supervised model servers: they die with ai-bootstrap, and a failed
// start-full is summarised for the diagnosis prompt.
import { fromFileUrl, join } from "@std/path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  endpointFromScript,
  logSummary,
  scriptPath,
  startFull,
  stopFull,
  supervise,
  SUPERVISE_SH,
} from "../src/intelligence.ts";

const unix = Deno.build.os !== "windows";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function alive(pattern: string): Promise<boolean> {
  return (await new Deno.Command("pgrep", { args: ["-f", pattern] }).output()).code === 0;
}

async function until(cond: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) if (await cond()) return true;
  return false;
}

/** A start script whose server leaves a grandchild behind, like docker or a wrapper would. */
async function treeScript(dir: string, tag: string): Promise<string> {
  const script = join(dir, "start.sh");
  await Deno.writeTextFile(script, `sleep 31${tag}1 &\nexec sleep 31${tag}2\n`);
  return script;
}

Deno.test({
  name: "supervise.sh stops the whole tree when the watched process exits",
  ignore: !unix,
}, async () => {
  const dir = await Deno.makeTempDir();
  const sup = join(dir, "supervise.sh");
  await Deno.writeTextFile(sup, SUPERVISE_SH);
  const script = await treeScript(dir, "7");
  const watched = new Deno.Command("sleep", { args: ["60"] }).spawn();
  const p = new Deno.Command("sh", {
    args: [sup, String(watched.pid), script],
    detached: true,
    stdout: "null",
    stderr: "null",
  }).spawn();
  assertEquals(await until(() => alive("sleep 3171")), true);
  assertEquals(await alive("sleep 3172"), true);
  watched.kill();
  await watched.status;
  await p.status;
  assertEquals(await until(async () => !(await alive("sleep 317[12]"))), true, "tree left running");
  await Deno.remove(dir, { recursive: true });
});

Deno.test({ name: "stop() ends the whole tree", ignore: !unix }, async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("AIBOOT_HOME", dir);
  try {
    const s = await supervise(await treeScript(dir, "8"), [], join(dir, "x.log"));
    assertEquals(await until(() => alive("sleep 3181")), true);
    s.stop();
    await s.exited;
    assertEquals(
      await until(async () => !(await alive("sleep 318[12]"))),
      true,
      "tree left running",
    );
  } finally {
    Deno.env.delete("AIBOOT_HOME");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logSummary: the last 5 lines and the last 5 mentioning errors", async () => {
  const dir = await Deno.makeTempDir();
  const log = join(dir, "full.log");
  const lines = [
    "loading",
    "ERROR: first",
    "warn",
    "an Error here",
    "x error 3",
    "error 4",
    "error 5",
    "progress 10%\rprogress 90%",
    "",
    "error 6",
    "a",
    "b",
    "c",
    "d",
  ];
  await Deno.writeTextFile(log, lines.join("\n"));
  const s = await logSummary(log);
  assertEquals(s.tail, ["error 6", "a", "b", "c", "d"]);
  assertEquals(s.errors, ["an Error here", "x error 3", "error 4", "error 5", "error 6"]);
  assertEquals((await logSummary(join(dir, "missing"))).tail, []);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("endpointFromScript reads the endpoint line", () => {
  assertEquals(endpointFromScript("#!/bin/sh\n# endpoint: http://127.0.0.1:8000/v1/ glm\nexec x"), {
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "glm",
  });
  assertEquals(endpointFromScript("rem endpoint: http://h:1/v1 m\r\n"), {
    baseUrl: "http://h:1/v1",
    model: "m",
  });
  assertEquals(endpointFromScript("exec vllm serve"), null);
});

Deno.test({ name: "startFull: up, failed, and no script", ignore: !unix }, async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("AIBOOT_HOME", dir);
  try {
    assertEquals(await startFull(null), null);
    await Deno.mkdir(join(dir, "intelligence"), { recursive: true });
    const script = scriptPath("full");

    // A model server that answers (the scripted mock: /models, and "ok" to a plain chat).
    const port = 18000 + Math.floor(Math.random() * 1000);
    const mock = fromFileUrl(new URL("./fixtures/mock_llm.ts", import.meta.url));
    const server = join(dir, "script.json");
    await Deno.writeTextFile(server, "[]");
    await Deno.writeTextFile(
      script,
      `#!/bin/sh\n# endpoint: http://127.0.0.1:${port}/v1 big\nexec '${Deno.execPath()}' run -A '${mock}' '${server}' ${port}\n`,
    );
    const up = await startFull(null);
    assertEquals(up && "ep" in up && up.ep.model, "big");
    stopFull();
    assertEquals(await until(async () => !(await alive(server))), true, "server left running");

    // A server that fails.
    await Deno.writeTextFile(
      script,
      `#!/bin/sh\n# endpoint: http://127.0.0.1:${port}/v1 big\necho starting\necho "CUDA error: out of memory" >&2\necho shutting down\nexit 3\n`,
    );
    const r = await startFull(null);
    if (!r || !("failure" in r)) throw new Error("expected a failure");
    assertStringIncludes(r.failure.reason, "exited with status 3");
    assertEquals(r.failure.errors, ["CUDA error: out of memory"]);
    assertEquals(r.failure.tail.length, 3);

    // No endpoint line and nothing saved: it cannot know when it is up.
    await Deno.writeTextFile(script, "#!/bin/sh\nexec sleep 1\n");
    const n = await startFull(null);
    if (!n || !("failure" in n)) throw new Error("expected a failure");
    assertStringIncludes(n.failure.reason, "# endpoint:");
  } finally {
    stopFull();
    Deno.env.delete("AIBOOT_HOME");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failure causes from the log", async () => {
  const { causeOf } = await import("../src/intelligence.ts");
  assertEquals(causeOf(["ggml_metal: error: failed to allocate buffer"], false), "memory");
  assertEquals(causeOf(["common_download_file_single_online: HTTP error 503"], false), "download");
  assertEquals(causeOf(["exiting"], true), "download");
  assertEquals(causeOf(["ggml_vulkan: no devices found"], false), "gpu");
  assertEquals(causeOf(["segfault"], false), "other");
});

Deno.test(
  { name: "an interrupted download is resumed; the previous log is kept", ignore: !unix },
  async () => {
    const dir = await Deno.makeTempDir();
    Deno.env.set("AIBOOT_HOME", dir);
    try {
      await Deno.mkdir(join(dir, "intelligence"), { recursive: true });
      const count = join(dir, "count");
      // Fails like a dropped download twice, then serves.
      const port = 19000 + Math.floor(Math.random() * 1000);
      const mock = fromFileUrl(new URL("./fixtures/mock_llm.ts", import.meta.url));
      await Deno.writeTextFile(join(dir, "s.json"), "[]");
      await Deno.writeTextFile(
        scriptPath("full"),
        `#!/bin/sh
# endpoint: http://127.0.0.1:${port}/v1 big
n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${count}'
if [ $n -lt 3 ]; then echo "attempt $n: common_download_file: connection reset"; exit 1; fi
exec '${Deno.execPath()}' run -A '${mock}' '${join(dir, "s.json")}' ${port}
`,
      );
      const r = await startFull(null);
      assertEquals(r && "ep" in r && r.ep.model, "big");
      assertEquals((await Deno.readTextFile(count)).trim(), "3");
      assertStringIncludes(
        await Deno.readTextFile(join(dir, "intelligence", "full.prev.log")),
        "attempt 2",
      );
    } finally {
      stopFull();
      Deno.env.delete("AIBOOT_HOME");
      await Deno.remove(dir, { recursive: true });
    }
  },
);
