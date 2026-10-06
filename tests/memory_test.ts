import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { INDEX_LIMIT, Memory } from "../src/memory.ts";

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
