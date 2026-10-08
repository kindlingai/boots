// Playbooks (memory playbook/<path>, run with run_playbook), memories kept
// to 10 kB and read whole, and the review of open goals after a restart.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Memory, MEMORY_LIMIT, playbookPath } from "../src/memory.ts";
import { Session } from "../src/tools.ts";
import { Router } from "../src/llm.ts";
import { McpManager } from "../src/mcp.ts";

async function session() {
  const dir = await Deno.makeTempDir();
  const s = new Session(
    new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
    new Memory(join(dir, "mem")),
    new McpManager(join(dir, "mcp.json")),
    () => Promise.resolve(null),
  );
  await s.init();
  return { s, dir, done: () => Deno.remove(dir, { recursive: true }) };
}

Deno.test("playbook names", () => {
  assertEquals(playbookPath("playbook/models/glm53flash/up"), "models/glm53flash/up");
  assertEquals(playbookPath("playbooks/models/glm53flash/up.sh"), "models/glm53flash/up");
  assertEquals(playbookPath("glm53-cluster"), null);
  for (
    const bad of ["playbook/../x", "playbook/a//b", "playbook/.hidden", "playbook/a/b/c/d/e/f/g"]
  ) {
    let threw = false;
    try {
      playbookPath(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
});

Deno.test("memories: at most 10 kB, refused (not cut) beyond, and read whole", async () => {
  const { s, dir, done } = await session();
  try {
    const big = "x".repeat(MEMORY_LIMIT + 10);
    // (Tool errors reach the model as the tool's result; here they throw.)
    const no = await s.exec("memory_write", { name: "glm53-cluster", content: big }).catch((
      e,
    ) => (e as Error).message);
    assertStringIncludes(no, "glm53-cluster would be");
    assertStringIncludes(no, "Nothing was written. Split it by topic");
    assertStringIncludes(no, "glm53-cluster-network");
    const m = new Memory(join(dir, "mem"));
    await assertRejects(() => m.read("glm53-cluster"));
    // Appending past the limit is refused too.
    await s.exec("memory_write", { name: "notes", content: "y".repeat(MEMORY_LIMIT - 100) });
    await assertRejects(
      () => s.exec("memory_write", { name: "notes", content: "z".repeat(200), append: true }),
      Error,
      "would be",
    );
    // Read whole: an older, bigger memory comes back uncut.
    await Deno.writeTextFile(join(dir, "mem", "old.md"), "a".repeat(30_000) + "END\n");
    const read = await s.exec("memory_read", { name: "old" });
    assertEquals(read.length, 30_004);
    assert(read.endsWith("END\n"));
  } finally {
    await done();
  }
});

Deno.test("playbooks: written as memory, listed with what they do, searched, and run after approval", async () => {
  const { s, dir, done } = await session();
  try {
    const script = '#!/bin/sh\n# Bring GLM-5.3 Flash up on the sparks\nset -eu\necho "up $1 $2"\n';
    assertStringIncludes(
      await s.exec("memory_write", { name: "playbook/models/glm53flash/up", content: script }),
      "wrote playbook/models/glm53flash/up",
    );
    assertEquals(
      await Deno.readTextFile(join(dir, "mem", "playbook", "models", "glm53flash", "up.sh")),
      script,
    );
    const m = new Memory(join(dir, "mem"));
    assertEquals(await m.playbooks(), [{
      name: "playbook/models/glm53flash/up",
      about: "Bring GLM-5.3 Flash up on the sparks",
    }]);
    assertEquals(await m.list(), [], "not among the memory files");
    assert(
      (await m.search("glm53flash sparks")).some((h) =>
        h.source === "playbook/models/glm53flash/up"
      ),
    );
    assertStringIncludes(
      await s.exec("memory_read", { name: "playbook/models/glm53flash/up" }),
      "set -eu",
    );

    // Run: shown and approved like a command; arguments as $1 $2.
    const asked: { what: string; key: string; kind?: string }[] = [];
    let answer: string | null = null;
    (s as any).gate = (what: string, key: string, kind?: string) => {
      asked.push({ what, key, kind });
      return Promise.resolve(answer);
    };
    const ran: { cmd: string; args: any }[] = [];
    (s as any).command = (_op: string, cmd: string, args: any) => {
      ran.push({ cmd, args });
      return Promise.resolve({ code: 0, stdout: "up a b'c\n", stderr: "", cmd });
    };
    const out = await s.exec("run_playbook", { name: "models/glm53flash/up", args: ["a", "b'c"] });
    assertStringIncludes(out, "playbook models/glm53flash/up: exit 0\nup a b'c");
    assertEquals(asked.length, 1);
    assertStringIncludes(asked[0].what, "playbook models/glm53flash/up a b'c");
    assertStringIncludes(asked[0].what, "Bring GLM-5.3 Flash up");
    assertEquals(asked[0].kind, undefined, "a plain yes / no / always");
    assertStringIncludes(asked[0].key, script, "always holds only while the script is unchanged");
    // Arguments as $1 $2 where the shell is POSIX (PowerShell hosts take the script as it is).
    assertEquals(
      ran[0].cmd,
      Deno.build.os === "windows"
        ? `$env:MEMORY_DIR = '${join(dir, "mem")}'\n${script}`
        : `MEMORY_DIR='${join(dir, "mem")}'; export MEMORY_DIR\nset -- 'a' 'b'\\''c'\n${script}`,
    );
    assertEquals(ran[0].args.timeout_s, 600);
    assertEquals(ran[0].args.local, true, "always on the local machine");
    // Even from a hop: still local, still asked about as local.
    (s as any).stack.push({ label: "admin@gx10", via: ["1"], info: { ...s.here.info } });
    await s.exec("run_playbook", { name: "models/glm53flash/up" });
    assertEquals(ran[1].args.local, true);
    assertStringIncludes(asked[1].what, "local");
    assert(!asked[1].what.includes("admin@gx10"), asked[1].what);
    (s as any).stack.pop();
    ran.length = 1;
    asked.length = 1;
    assertEquals(ran[0].args.label, "playbook models/glm53flash/up");

    // --allow-playbooks: runs without asking.
    s.applyPermissions({
      readonly: false,
      hosts: [],
      allHosts: false,
      skip: false,
      playbooks: true,
    });
    assertStringIncludes(await s.exec("run_playbook", { name: "models/glm53flash/up" }), "exit 0");
    assertEquals(asked.length, 1, "not asked");
    assertEquals(ran.length, 2);
    ran.length = 1;
    s.allowPlaybooks = false;
    answer = "the user declined to run this";
    assertEquals(await s.exec("run_playbook", { name: "playbook/models/glm53flash/up" }), answer);
    assertEquals(ran.length, 1);
    assertStringIncludes(
      await s.exec("run_playbook", { name: "models/glm53flash/down" }),
      "no playbook/models/glm53flash/down; playbooks: playbook/models/glm53flash/up",
    );
    assertStringIncludes(
      await s.exec("run_playbook", { name: "../etc/passwd" }),
      "bad playbook name",
    );
  } finally {
    await done();
  }
});

Deno.test("a restart with open goals opens with a review of them", async () => {
  const { repl, RESTART_GOALS, Agent } = await import("../src/agent.ts");
  const turns: string[] = [];
  const fake: any = {
    fullFailure: null,
    where: () => "local",
    mode: "ask",
    router: {
      current: () => ({ label: "big", model: "gpt-oss-120b", contextChars: 1e5 }),
      bootstrap: { label: "b" },
    },
    memory: {
      isEmpty: () => Promise.resolve(false),
      goals: () => Promise.resolve(JSON.stringify([{ title: "Serve GLM", done: false }])),
    },
  };
  const agent = {
    s: fake,
    turn: (t: string) => (turns.push(t), Promise.resolve()),
  } as unknown as InstanceType<typeof Agent>;
  const { setFrontend } = await import("../src/frontend.ts");
  setFrontend({ emit() {}, readLine: () => Promise.resolve(null), close() {} });
  await repl(agent);
  assertEquals(turns, [RESTART_GOALS]);
  // All done: the usual prompt, no review.
  turns.length = 0;
  fake.memory.goals = () => Promise.resolve(JSON.stringify([{ title: "Serve GLM", done: true }]));
  await repl(agent);
  assertEquals(turns, []);
});

Deno.test("run_playbook lists the playbooks there are, where the model looks", async () => {
  const { TOOLS, withPlaybooks } = await import("../src/tools.ts");
  const t = TOOLS.find((x) => x.function.name === "run_playbook")!;
  assertStringIncludes(withPlaybooks(t, []).function.description, "There are none yet");
  const d = withPlaybooks(t, [
    { name: "playbook/models/glm53flash/up", about: "Bring GLM-5.3 Flash up on the sparks" },
    { name: "playbook/fleet/health", about: "" },
  ]).function.description;
  assertStringIncludes(
    d,
    "Playbooks now: models/glm53flash/up (Bring GLM-5.3 Flash up on the sparks); fleet/health.",
  );
  assert(!t.function.description.includes("Playbooks now"), "the shared definition is left alone");
});
