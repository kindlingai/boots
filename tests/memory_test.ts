import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { FLEET_LIMIT, INDEX_LIMIT, Memory } from "../src/memory.ts";

async function mem() {
  const d = await Deno.makeTempDir();
  const docs = join(d, "docs");
  await Deno.mkdir(docs);
  await Deno.writeTextFile(join(docs, "vllm.md"), "# vLLM\nRun `vllm serve` on port 8000.\n");
  const m = new Memory(join(d, "memory"), docs);
  await m.init();
  return m;
}

Deno.test("INDEX is seeded and capped at 4 kB", async () => {
  const m = await mem();
  assertStringIncludes(await m.index(), "local-setup");
  await m.write("INDEX", "x".repeat(INDEX_LIMIT - 10));
  await assertRejects(() => m.write("INDEX", "x".repeat(INDEX_LIMIT + 1)), Error, "limit");
  await assertRejects(() => m.write("INDEX", "y".repeat(100), true), Error, "limit");
});

Deno.test("write, append, read, search across memories and docs", async () => {
  const m = await mem();
  await m.write("gpu-boxes", "- gpu-1: 2x RTX 4090, vllm on 8000");
  await m.write("gpu-boxes", "- gpu-2: A100", true);
  assertEquals(await m.read("gpu-boxes"), "- gpu-1: 2x RTX 4090, vllm on 8000\n- gpu-2: A100\n");
  const hits = await m.search("vllm port");
  assert(hits.some((h) => h.source === "docs/vllm"));
  assert(hits.some((h) => h.source === "gpu-boxes"));
  assertStringIncludes(await m.read("docs/vllm"), "vllm serve");
  await assertRejects(() => m.write("docs/vllm", "x"), Error, "read-only");
  await assertRejects(() => m.read("../etc/passwd"), Error, "bad memory name");
});

Deno.test("local-setup keeps notes below the marker", async () => {
  const m = await mem();
  await m.recordLocalSetup("- host: one");
  await m.write("local-setup", (await m.read("local-setup")) + "user note\n");
  await m.recordLocalSetup("- host: two");
  const t = await m.read("local-setup");
  assertStringIncludes(t, "host: two");
  assertStringIncludes(t, "user note");
});

Deno.test("memory syncs between two machines through a git remote", async () => {
  const d = await Deno.makeTempDir();
  const bare = join(d, "remote.git");
  await new Deno.Command("git", { args: ["init", "-q", "--bare", "-b", "main", bare] }).output();
  const a = new Memory(join(d, "a"), join(d, "nodocs"));
  const b = new Memory(join(d, "b"), join(d, "nodocs"));
  await a.init();
  await a.write("boxes", "- gpu-1 from a");
  assertStringIncludes(await a.sync(bare), "local changes pushed");
  await b.init();
  await b.sync(bare);
  assertEquals(await b.read("boxes"), "- gpu-1 from a\n");
  await b.write("boxes", "- gpu-2 from b", true);
  await b.sync();
  assertStringIncludes(String(await a.pull()), "synced");
  assertStringIncludes(await a.read("boxes"), "gpu-2 from b");
  assertEquals(await new Memory(join(d, "c")).remote(), null);
});

Deno.test("search matches whole words and ranks doc names", async () => {
  const d = await Deno.makeTempDir();
  const docs = join(d, "docs");
  await Deno.mkdir(docs);
  await Deno.writeTextFile(join(docs, "ray.md"), "# Ray\nCluster framework.\n");
  await Deno.writeTextFile(join(docs, "misc.md"), "# Misc\nan array of disks\n");
  const m = new Memory(join(d, "memory"), docs);
  await m.init();
  const hits = await m.search("ray");
  assertEquals(hits.map((h) => h.source), ["docs/ray"]);
  assertEquals((await m.search("the and of")).length, 0);
});

Deno.test("memory is empty until something about the user is recorded", async () => {
  const m = await mem();
  assert(await m.isEmpty());
  await m.recordLocalSetup("- host: x");
  assert(await m.isEmpty(), "the automatic local-setup does not count");
  await m.write("machines", "- gpu-1");
  assert(!(await m.isEmpty()));
});

Deno.test("fleet.json only accepts a valid JSON object", async () => {
  const m = await mem();
  assertEquals(await m.read("fleet.json"), "{}\n");
  assertEquals(await m.fleet(), "");
  await assertRejects(() => m.write("fleet.json", "{hosts: {}}"), Error, "not valid JSON");
  await assertRejects(() => m.write("fleet.json", "[1, 2]"), Error, "must be a JSON object");
  await assertRejects(() => m.write("fleet.json", "null"), Error, "must be a JSON object");
  await assertRejects(() => m.write("fleet.json", "{}", true), Error, "cannot be appended");
  await assertRejects(
    () => m.write("fleet.json", JSON.stringify({ notes: "x".repeat(FLEET_LIMIT) })),
    Error,
    "limit",
  );
  assertEquals(await m.fleet(), "", "a refused write leaves no file");
  assert(await m.isEmpty());
  const r = await m.write(
    "fleet.json",
    '{"hosts":{"spark-1":{"models":[{"name":"glm53","openai_url":"http://10.0.0.21:8000/v1"}]}}}',
  );
  assertStringIncludes(r, "wrote fleet.json");
  const stored = await m.read("fleet");
  assertEquals(JSON.parse(stored).hosts["spark-1"].models[0].name, "glm53");
  assertStringIncludes(stored, '\n  "hosts": {', "stored pretty-printed");
  assert(!(await m.isEmpty()), "a fleet counts as knowing the user");
  assert((await m.search("glm53")).some((h) => h.source === "fleet.json"));
  assert(!(await m.list()).includes("fleet.json"), "listed separately from Markdown memories");
});

Deno.test("goals.json: a checked list of goals, always JSON", async () => {
  const { checkGoals } = await import("../src/memory.ts");
  const dir = await Deno.makeTempDir();
  try {
    const m = new Memory(join(dir, "mem"));
    await m.init();
    assertEquals(await m.read("goals.json"), "[]\n");
    const goals = [
      { title: "Run the 30B-A3B on the Mac", done: true },
      { title: "Serve GLM on the Sparks", children: [{ title: "mentat router up", done: false }] },
    ];
    assertStringIncludes(await m.write("goals.json", JSON.stringify(goals)), "wrote goals.json");
    // Nothing was active: the first unfinished goal is made active.
    const saved = structuredClone(goals) as any[];
    saved[1].active = true;
    assertEquals(JSON.parse(await m.goals()), saved);
    // Not the shape: refused, and the stored goals stay as they were.
    for (
      const [bad, why] of [
        ['{"title": "x"}', "must be a list"],
        ['[{"done": true}]', "goals[0].title must be a non-empty string"],
        ['[{"title": "x", "done": "yes"}]', "goals[0].done must be true or false"],
        ['[{"title": "x", "active": 1}]', "goals[0].active must be true or false"],
        ['[{"title": "x", "details": 3}]', "goals[0].details must be a string"],
        ['[{"title": "x", "priority": 1}]', "goals[0] has priority"],
        ['[{"title": "x", "children": [{"title": ""}]}]', "goals[0].children[0].title"],
        ['[{"title": "x", "children": {}}]', "goals[0].children must be a list"],
        ["[1]", "goals[0] must be an object"],
      ]
    ) {
      await assertRejects(() => m.write("goals.json", bad), Error, why);
    }
    assertEquals(JSON.parse(await m.goals()), saved);
    assertEquals(checkGoals([]), null);
    // A goals list means the user has told us something: no onboarding.
    assertEquals(await m.isEmpty(), false);
    // A bare "goals" is still an ordinary memory (onboarding used to write one).
    await m.write("goals", "- old notes");
    assertStringIncludes(await m.read("goals"), "old notes");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("goals: details for the model, active cleared when done, first open one active", async () => {
  const { normalizeGoals, activeGoals } = await import("../src/memory.ts");
  const g = normalizeGoals([
    { title: "A", done: true, active: true },
    { title: "B", details: "on spark-1, port 41873", children: [{ title: "B1", active: true }] },
    { title: "C" },
  ]);
  // A finished goal is never active; B1 was already active, so nothing else is made so.
  assertEquals(g[0].active, undefined);
  assertEquals(g[1].active, undefined);
  assertEquals(activeGoals(g).map((x) => x.title), ["B1"]);
  // B1 done: nothing active, so the first open top-level goal (B) is.
  g[1].children![0].done = true;
  normalizeGoals(g);
  assertEquals(activeGoals(g).map((x) => x.title), ["B"]);
  assertEquals(activeGoals(g)[0].details, "on spark-1, port 41873");
  // active: false is dropped (it is the default).
  assertEquals(normalizeGoals([{ title: "X", done: true }, { title: "Y", active: false }])[1], {
    title: "Y",
    active: true,
  });
  assertEquals(normalizeGoals([{ title: "X", done: true }]), [{ title: "X", done: true }]);
});
