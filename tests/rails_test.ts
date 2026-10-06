import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CATALOG, fitAll, fullScript, needsGB, parseDevices } from "../src/rails.ts";

Deno.test("the catalog: a few Qwen models of 8-16 GB, best first", () => {
  assert(CATALOG.length >= 3 && CATALOG.length <= 5);
  for (const m of CATALOG) {
    assert(m.fileGB >= 8 && m.fileGB <= 16, m.id);
    assert(/^unsloth\/Qwen3-.+-GGUF:\S+$/.test(m.hf), m.hf);
  }
});

Deno.test("parseDevices reads llama-server --list-devices", () => {
  const out = `ggml_vulkan: Found 1 Vulkan devices:
Available devices:
  Vulkan0: NVIDIA GeForce RTX 4090 (24564 MiB, 23012 MiB free)
  MTL0: Apple M3 Pro (27648 MiB, 27600 MiB free)
`;
  assertEquals(parseDevices(out), [
    { name: "Vulkan0", description: "NVIDIA GeForce RTX 4090", totalMB: 24564, freeMB: 23012 },
    { name: "MTL0", description: "Apple M3 Pro", totalMB: 27648, freeMB: 27600 },
  ]);
  assertEquals(parseDevices("Available devices:\n"), []);
});

Deno.test("fitting: the best model that fits, with as much context as fits", () => {
  // An M3 Pro with 36 GB: about 27 GB for Metal.
  const mac = fitAll(27);
  assert(mac[0].fits);
  assertEquals(mac[0].ctx, 32768);
  // A 12 GB card: only the smallest, with less context.
  const small = fitAll(12.8);
  assertEquals(small.filter((f) => f.fits).map((f) => f.model.id), ["qwen3-8b"]);
  assertEquals(small.find((f) => f.fits)!.ctx, 16384);
  // 8 GB: nothing.
  assertEquals(fitAll(8).some((f) => f.fits), false);
  assert(needsGB(CATALOG[0], 32768) > needsGB(CATALOG[0], 16384));
});

Deno.test("start-full.sh for a catalog model", () => {
  const s = fullScript(
    CATALOG[0],
    "/c/llama-gpu/b1/llama-server",
    41234,
    32768,
    "MTL0 Apple M3 Pro",
    false,
  );
  assertStringIncludes(s, "# endpoint: http://127.0.0.1:41234/v1 qwen3-30b-a3b");
  assertStringIncludes(
    s,
    "exec '/c/llama-gpu/b1/llama-server' -hf unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:UD-Q3_K_XL --alias qwen3-30b-a3b --host 127.0.0.1 --port 41234 --jinja -c 32768",
  );
  const w = fullScript(CATALOG[1], "C:\\\\l\\\\llama-server.exe", 41234, 16384, "Vulkan0", true);
  assertStringIncludes(w, "rem endpoint: http://127.0.0.1:41234/v1 qwen3-14b");
});
