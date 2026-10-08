// force_prompt on run and sudo: never refused, never checked, always asked
// (unless every permission is skipped).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Memory } from "../src/memory.ts";
import { Session } from "../src/tools.ts";
import { Router } from "../src/llm.ts";
import { McpManager } from "../src/mcp.ts";

Deno.test("force_prompt: no refusal, no check, the user asked every time", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
      new Memory(join(dir, "mem")),
      new McpManager(join(dir, "mcp.json")),
      () => Promise.resolve(null),
    );
    await s.init();
    // Everything that would let a command through unasked, switched on.
    s.allowReadonly = true;
    s.mode = "auto";
    (s as any).always = { has: () => true, add() {} };
    let checked = 0;
    (s as any).check = () => (checked++, Promise.resolve({ verdict: "complex", checked: true }));
    const asked: { what: string; kind?: string }[] = [];
    let answer: string | null = null;
    (s as any).gate = (what: string, _k: string, kind?: string) => {
      asked.push({ what, kind });
      return Promise.resolve(answer);
    };
    const ran: { op: string; cmd: string }[] = [];
    (s as any).command = (op: string, cmd: string) => {
      ran.push({ op, cmd });
      return Promise.resolve({ code: 0, stdout: "done\n", stderr: "", cmd });
    };
    const weird = "eval \"$(python3 -c 'print(42)')\" | while read x; do sudo echo $x; done";
    const r = await s.exec("run", { command: weird, force_prompt: true });
    assertStringIncludes(r, "exit 0");
    assertEquals(ran, [{ op: "exec", cmd: weird }], "run as it is, sudo and all");
    assertEquals(checked, 0, "not checked");
    assertEquals(asked.length, 1);
    assertEquals(asked[0].kind, "dangerous", "yes or no, never remembered");
    assertStringIncludes(asked[0].what, "not checked: read it before you say yes");
    // Again: asked again.
    await s.exec("run", { command: weird, force_prompt: true });
    assertEquals(asked.length, 2);
    // Declined: not run.
    answer = "the user declined to run this";
    assertEquals(await s.exec("run", { command: weird, force_prompt: true }), answer);
    assertEquals(ran.length, 2);
    // sudo: asked as root.
    answer = null;
    await s.exec("sudo", { command: "ssh x 'a | b'", force_prompt: true });
    assertEquals(ran.at(-1), { op: "sudo", cmd: "ssh x 'a | b'" });
    assertEquals(asked.at(-1)!.kind, "root");
    // Without it, the same command is still refused or sent back.
    assert((await s.exec("sudo", { command: "ssh x uptime" })).startsWith("Not run"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
