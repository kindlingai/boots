// Drives a real far agent over pipes, as ssh would.
import { fromFileUrl } from "@std/path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { Rpc } from "../src/rpc.ts";
import { b64 } from "../src/host.ts";

Deno.test({
  name: "far agent: info, exec with persistent cwd, write and read",
  // The commands below are POSIX shell; Windows hosts run PowerShell.
  ignore: Deno.build.os === "windows",
}, async () => {
  const main = fromFileUrl(new URL("../src/main.ts", import.meta.url));
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", main, "--far"],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const rpc = new Rpc(p.stdout, p.stdin);
  try {
    const info = await rpc.call("info");
    assertEquals(info.target, Deno.build.target);
    const dir = await Deno.makeTempDir();
    let r = await rpc.call("exec", { cmd: `cd ${dir} && echo hi` });
    assertEquals(r.code, 0);
    assertEquals(r.stdout, "hi\n");
    assertEquals(r.cwd, dir);
    r = await rpc.call("exec", { cmd: "pwd; exit 3" });
    assertEquals(r.code, 3);
    assertEquals(r.stdout.trim(), dir);
    await rpc.call("write", { path: "sub/f.txt", b64: b64("hello\n"), mode: "0600" });
    const f = await rpc.call("read", { path: "sub/f.txt" });
    assertEquals(f.content, "hello\n");
    assertEquals((await Deno.stat(`${dir}/sub/f.txt`)).mode! & 0o777, 0o600);
    r = await rpc.call("exec", { cmd: "sleep 5", timeoutMs: 300 });
    assertStringIncludes(r.stderr, "timed out");
  } finally {
    await rpc.close();
    await p.status;
  }
});
