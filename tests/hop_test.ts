// Builds for machines further down a hop chain come from the machine above,
// remote caches are pruned, and running commands report their latest line.
import { join } from "@std/path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import { binaryFor, checksumFor, pruneRemote, setUpstream } from "../src/ssh.ts";
import { Host, lastLine } from "../src/host.ts";

const unix = Deno.build.os !== "windows";
const other = Deno.build.target.includes("aarch64")
  ? "x86_64-unknown-linux-gnu"
  : "aarch64-unknown-linux-gnu";

Deno.test("SHA256SUMS lines", () => {
  const h = "a".repeat(64);
  assertEquals(checksumFor(`${h}  ai-bootstrap-1-x.tar.gz\n`, "ai-bootstrap-1-x.tar.gz"), h);
  assertEquals(checksumFor(`${h} *ai-bootstrap-1-x.zip`, "ai-bootstrap-1-x.zip"), h);
  assertEquals(checksumFor(`${h}  other`, "ai-bootstrap-1-x.zip"), null);
});

Deno.test("a hop gets a build it lacks from the machine above, in chunks", async () => {
  const dir = await Deno.makeTempDir();
  const data = new Uint8Array(5 * 1024 * 1024 + 123).map((_, i) => i % 251);
  const sha = encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
  const calls: string[] = [];
  let damage = false;
  setUpstream((op, args: any) => {
    calls.push(op);
    if (op === "binary_info") return Promise.resolve({ size: data.length, sha256: sha });
    const part = data.slice(args.offset, args.offset + args.length);
    if (damage) part[0] ^= 1;
    return Promise.resolve({ b64: encodeBase64(part) });
  });
  Deno.env.set("AIBOOT_CACHE", join(dir, "cache"));
  try {
    damage = true;
    await assertRejects(() => binaryFor(other, () => {}), Error, "damaged");
    damage = false;
    calls.length = 0;
    const path = await binaryFor(other, () => {});
    assertEquals(await Deno.readFile(path), data);
    assertEquals(calls, ["binary_info", "binary_chunk", "binary_chunk", "binary_chunk"]);
    calls.length = 0;
    await binaryFor(other, () => {});
    assertEquals(calls, [], "cached after the first time");
  } finally {
    setUpstream(null);
    Deno.env.delete("AIBOOT_CACHE");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({ name: "remote prune keeps the current build", ignore: !unix }, async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (const f of ["ai-bootstrap-new", "ai-bootstrap-old", "ai-bootstrap-new.tmp", "keep.txt"]) {
      await Deno.writeTextFile(join(dir, f), "x");
    }
    const o = await new Deno.Command("sh", { args: ["-c", pruneRemote(dir, "ai-bootstrap-new")] })
      .output();
    assertEquals(o.code, 0);
    const left = [];
    for await (const e of Deno.readDir(dir)) left.push(e.name);
    assertEquals(left.sort(), ["ai-bootstrap-new", "ai-bootstrap-new.tmp", "keep.txt"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("latest output line", () => {
  assertEquals(lastLine("a\nb\n"), "b");
  assertEquals(lastLine("Downloading 10%\rDownloading 55%\r"), "Downloading 55%");
  assertEquals(lastLine("\x1b[32mok\x1b[0m\n\n"), "ok");
  assertEquals(lastLine("\n  \n"), "");
});

Deno.test({ name: "a running command reports its latest line", ignore: !unix }, async () => {
  const host = new Host(() => Promise.resolve(null));
  const seen: string[] = [];
  host.onLine = (token, line) => seen.push(`${token}:${line}`);
  const r = await host.handle("exec", {
    cmd: "echo one; sleep 0.5; echo two; sleep 0.5; echo three",
    token: "t1",
    timeoutMs: 10_000,
  }, []) as any;
  assertEquals(r.stdout.trim().split("\n"), ["one", "two", "three"]);
  await new Promise((ok) => setTimeout(ok, 400));
  assert(seen.includes("t1:one") && seen.includes("t1:two"), seen.join(","));
});
