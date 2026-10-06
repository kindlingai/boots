// The command checker, what run refuses, and stopping commands (^C, timeouts).
import { join } from "@std/path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Classifier, guard, parseVerdict } from "../src/classify.ts";
import { Host } from "../src/host.ts";
import { Router } from "../src/llm.ts";
import { Memory } from "../src/memory.ts";
import { McpManager } from "../src/mcp.ts";
import { refuseInRun, Session } from "../src/tools.ts";
import { serveMock } from "./fixtures/mock_llm.ts";

const unix = Deno.build.os !== "windows";

Deno.test("parseVerdict and the hard rules", () => {
  assertEquals(parseVerdict("readonly"), "readonly");
  assertEquals(parseVerdict("Read-only."), "readonly");
  assertEquals(parseVerdict("**Dangerous**"), "dangerous");
  assertEquals(parseVerdict("I think it is complex"), "complex");
  assertEquals(parseVerdict("no idea"), null);
  // A model that calls a writing command read-only is overruled.
  assertEquals(guard("rm -rf /tmp/x", "readonly"), "writes");
  assertEquals(guard("echo hi > /etc/motd", "readonly"), "writes");
  assertEquals(guard("echo $(id)", "readonly"), "writes");
  assertEquals(guard("python3 -c 'print(1)'", "readonly"), "writes");
  assertEquals(guard("curl -s -o x http://h", "readonly"), "writes");
  assertEquals(guard("curl -s http://127.0.0.1:1234/v1/models", "readonly"), "readonly");
  assertEquals(guard("ls 2>/dev/null", "readonly"), "readonly");
  assertEquals(guard("x".repeat(700), "readonly"), "complex");
});

Deno.test("run refuses sudo and model servers, not mentions of them", () => {
  for (
    const c of [
      "sudo lsof -i :11434",
      "ps aux | sudo grep x",
      "ollama serve",
      "OLLAMA_HOST=0.0.0.0 ollama serve",
      "nohup ollama serve > log 2>&1 &",
      "/opt/llama/bin/llama-server -hf a/b:Q4 --port 9",
      "exec vllm serve Qwen/Qwen3-8B",
      "python3 -m vllm.entrypoints.openai.api_server --model x",
      "python -m sglang.launch_server --model-path x",
    ]
  ) assert(refuseInRun(c), c);
  for (
    const c of [
      "grep llama-server ~/x.log",
      "ollama list",
      "llama-server --version",
      "echo sudo",
      "ps aux | grep 'ollama serve'",
      "nohup sh start-qwen.sh > qwen.log 2>&1 &",
      "vllm --version",
    ]
  ) assertEquals(refuseInRun(c), null, c);
});

Deno.test("the bootstrap model classifies, once per command", async () => {
  let asked = 0;
  const m = serveMock([], 0, (cmd) => {
    asked++;
    return cmd.startsWith("dd") ? "dangerous" : cmd.includes("awk") ? "complex" : "readonly";
  });
  try {
    const c = new Classifier(() => ({ label: "m", baseUrl: m.url, model: "m", contextChars: 1e4 }));
    assertEquals(await c.classify("my-gpu-tool --query", "macOS"), "readonly");
    assertEquals(await c.classify("my-gpu-tool --query", "macOS"), "readonly");
    assertEquals(asked, 1);
    assertEquals(await c.classify("dd if=/dev/zero of=/dev/sda", "Linux"), "dangerous");
    assertEquals(await c.classify("awk '{s+=$1} END {print s}' f", "Linux"), "complex");
    // The model says read-only; the hard rules say otherwise.
    assertEquals(await c.classify("mkdir -p /tmp/x", "Linux"), "writes");
    const down = new Classifier(() => ({
      label: "x",
      baseUrl: "http://127.0.0.1:9/v1",
      model: "x",
      contextChars: 1e4,
    }));
    assertEquals(await down.classify("foo", "Linux"), null);
  } finally {
    await m.close();
  }
});

Deno.test({ name: "a complex command goes back to the model, unrun", ignore: !unix }, async () => {
  const m = serveMock([], 0, () => "complex");
  const dir = await Deno.makeTempDir();
  try {
    const router = new Router({ label: "m", baseUrl: m.url, model: "m", contextChars: 1e4 });
    const s = new Session(
      router,
      new Memory(join(dir, "mem")),
      new McpManager(join(dir, "mcp.json")),
      () => Promise.resolve(null),
    );
    await s.init();
    const marker = join(dir, "ran");
    const r = await s.exec("run", { command: `for i in 1; do touch ${marker}; done` });
    assertStringIncludes(r, "too complex");
    assertEquals(await Deno.stat(marker).then(() => true, () => false), false);
    // Refused outright, without asking the user.
    assertStringIncludes(await s.exec("run", { command: "ollama serve" }), "start script");
    assertStringIncludes(await s.exec("run", { command: "sudo ls" }), "sudo tool");
    // Read-only by the list, with read-only allowed: runs without a prompt.
    s.allowReadonly = true;
    assertStringIncludes(await s.exec("run", { command: "echo hello" }), "hello");
  } finally {
    await m.close();
    await Deno.remove(dir, { recursive: true });
  }
});

async function alive(pattern: string): Promise<boolean> {
  return (await new Deno.Command("pgrep", { args: ["-f", pattern] }).output()).code === 0;
}

Deno.test({ name: "a timeout stops the command and what it started", ignore: !unix }, async () => {
  const h = new Host(() => Promise.resolve(null));
  const t0 = Date.now();
  const r: any = await h.handle("exec", { cmd: "sleep 5551 & sleep 5552", timeoutMs: 500 }, []);
  assert(Date.now() - t0 < 5000);
  assert(r.timedOut);
  assertStringIncludes(r.stderr, "timed out");
  await new Promise((res) => setTimeout(res, 300));
  assertEquals(await alive("sleep 555[12]"), false, "left running");
});

Deno.test({ name: "cancel by token stops a running command", ignore: !unix }, async () => {
  const h = new Host(() => Promise.resolve(null));
  const p = h.handle(
    "exec",
    { cmd: "sleep 5561 & sleep 5562", token: "t1", timeoutMs: 60_000 },
    [],
  );
  await new Promise((res) => setTimeout(res, 300));
  await h.handle("cancel", { token: "t1" }, []);
  const r: any = await p;
  assert(r.cancelled);
  assertStringIncludes(r.stderr, "stopped by the user");
  await new Promise((res) => setTimeout(res, 300));
  assertEquals(await alive("sleep 556[12]"), false, "left running");
});
