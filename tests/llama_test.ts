import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { baseScript, dirSize } from "../src/llama.ts";

Deno.test("dirSize counts files in nested directories, and 0 for a missing one", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "a", "b"), { recursive: true });
  await Deno.writeFile(join(dir, "x"), new Uint8Array(1000));
  await Deno.writeFile(join(dir, "a", "b", "y.downloadInProgress"), new Uint8Array(234));
  assertEquals(await dirSize(dir), 1234);
  assertEquals(await dirSize(join(dir, "missing")), 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test({
  name: "start-base.sh runs the server and stops it when the watched process exits",
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  // A stand-in llama-server that records its arguments and runs until killed.
  const server = join(dir, "llama server's");
  await Deno.writeTextFile(server, `#!/bin/sh\necho "$@" > "$LLAMA_CACHE/args"\nexec sleep 60\n`);
  await Deno.chmod(server, 0o755);
  const script = join(dir, "start-base.sh");
  await Deno.writeTextFile(script, baseScript(server, "org/m:Q4", dir, false));
  const watched = new Deno.Command("sleep", { args: ["30"] }).spawn();
  const p = new Deno.Command("sh", {
    args: [script, "18123", String(watched.pid)],
    stdout: "null",
    stderr: "null",
  }).spawn();
  let args = "";
  for (let i = 0; i < 50 && !args; i++) {
    await new Promise((r) => setTimeout(r, 100));
    args = await Deno.readTextFile(join(dir, "args")).catch(() => "");
  }
  assertEquals(args.trim(), "-hf org/m:Q4 --host 127.0.0.1 --jinja -c 16384 --port 18123");
  watched.kill();
  await watched.status;
  // The script notices within a second or two and takes the server down with it.
  const t0 = Date.now();
  await p.status;
  assertEquals(Date.now() - t0 < 5000, true);
  const left = await new Deno.Command("pgrep", { args: ["-f", server] }).output();
  assertEquals(left.code, 1, "the server is still running");
  await Deno.remove(dir, { recursive: true });
});
