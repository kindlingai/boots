import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { bootstrapScript, dirSize } from "../src/llama.ts";

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
  name: "start-bootstrap.sh runs llama-server in the foreground with the model cache",
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  // A stand-in llama-server that records its arguments and cache.
  const server = join(dir, "llama server's");
  await Deno.writeTextFile(server, `#!/bin/sh\necho "$LLAMA_CACHE $@"\n`);
  await Deno.chmod(server, 0o755);
  const script = join(dir, "start-bootstrap.sh");
  await Deno.writeTextFile(
    script,
    bootstrapScript(server, "org/m:Q4", join(dir, "m"), 41234, false),
  );
  const run = async (args: string[]) =>
    new TextDecoder().decode((await new Deno.Command("sh", { args }).output()).stdout).trim();
  const expect = `${join(dir, "m")} -hf org/m:Q4 --host 127.0.0.1 --jinja -c 16384 --port`;
  assertEquals(await run([script, "28123"]), `${expect} 28123`);
  // Run by hand: the port picked when it was written.
  assertEquals(await run([script]), `${expect} 41234`);
  await Deno.remove(dir, { recursive: true });
});
