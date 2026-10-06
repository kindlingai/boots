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

Deno.test("downloads: what belongs to whom, and what can go", async () => {
  const { downloads, removable } = await import("../src/rails.ts");
  const { basename, join } = await import("@std/path");
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeFile(
      join(
        dir,
        "unsloth_Qwen3-30B-A3B-Instruct-2507-GGUF_Qwen3-30B-A3B-Instruct-2507-UD-Q3_K_XL.gguf.downloadInProgress",
      ),
      new Uint8Array(300),
    );
    await Deno.writeFile(
      join(dir, "unsloth_Qwen3-14B-GGUF_Qwen3-14B-Q6_K.gguf"),
      new Uint8Array(200),
    );
    await Deno.mkdir(join(dir, "models--unsloth--Qwen3-4B-Instruct-2507-GGUF", "blobs"), {
      recursive: true,
    });
    await Deno.writeFile(
      join(dir, "models--unsloth--Qwen3-4B-Instruct-2507-GGUF", "blobs", "x"),
      new Uint8Array(100),
    );
    await Deno.writeFile(join(dir, "my-own-model.gguf"), new Uint8Array(50));
    const all = await downloads(dir, "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M");
    const by = (s: string) => all.find((d) => d.path.includes(s))!;
    assertEquals(by("30B").models, ["qwen3-30b-a3b"]);
    assertEquals(by("30B").partial, true);
    assertEquals(by("14B").models, ["qwen3-14b"]);
    assertEquals(by("Qwen3-4B").models, ["bootstrap"]);
    assertEquals(by("Qwen3-4B").bytes, 100);
    assertEquals(by("my-own").models, []);
    // Never the bootstrap or a file that is not ours; the kept model stays, even unfinished.
    const names = (k?: string) =>
      removable(all, k).map((d) => basename(d.path).slice(0, 22)).sort();
    assertEquals(names(), ["unsloth_Qwen3-14B-GGUF", "unsloth_Qwen3-30B-A3B-"]);
    assertEquals(names("qwen3-30b-a3b"), ["unsloth_Qwen3-14B-GGUF"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("disk: a model that fits the GPU but not the disk is not recommended", async () => {
  const { withDisk, describePlan } = await import("../src/rails.ts");
  const GB = 2 ** 30;
  const partial30b = {
    path: "/m/unsloth_Qwen3-30B-A3B-Instruct-2507-GGUF_x.gguf.downloadInProgress",
    bytes: 6.5 * GB,
    partial: true,
    models: ["qwen3-30b-a3b"],
  };
  const fits = withDisk(fitAll(27), [partial30b], 5);
  // 13.8 GB, 6.5 already here: 7.3 + 2 margin needed, 5 free.
  assertEquals(fits[0].diskOK, false);
  assertEquals(Math.round(fits[0].diskNeedGB! * 10) / 10, 9.3);
  const text = describePlan({
    server: "s",
    devices: [],
    budgetGB: 27,
    accel: "MTL0 Apple M3 Pro",
    warning: null,
    fits,
    diskFreeGB: 5,
    downloads: [partial30b],
  });
  assertStringIncludes(text, "NOT ENOUGH DISK");
  assertStringIncludes(
    text,
    "Low disk: qwen3-30b-a3b needs 9.3 GB free, and there is 5.0 GB. Warn the user.",
  );
  assertStringIncludes(text, "qwen3-30b-a3b 6.5 GB (unfinished)");
  assert(!text.includes("Recommended: qwen3-30b-a3b"));
});
