// A new hop is a new login: the shared connection (ControlMaster) to the
// machine is stopped first, so groups added since (docker) are there.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { openSsh } from "../src/ssh.ts";

Deno.test({
  name: "ssh: a hop stops any old shared connection before it logs in",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const log = join(dir, "calls");
    await Deno.writeTextFile(
      join(dir, "ssh"),
      `#!/bin/sh\necho "$*" >> '${log}'\nexit 255\n`,
    );
    await Deno.chmod(join(dir, "ssh"), 0o755);
    const path = Deno.env.get("PATH") ?? "";
    Deno.env.set("PATH", `${dir}:${path}`);
    try {
      await assertRejects(() =>
        openSsh("admin@gx10", "2222", () => Promise.resolve(null), () => {})
      );
      const calls = (await Deno.readTextFile(log)).trim().split("\n");
      assert(calls[0].endsWith("-O exit admin@gx10"), calls[0]);
      assert(calls[0].includes("ControlPath="), "the same master the hop would use");
      assert(calls[1].includes("admin@gx10 -- sh -c"), "then the login");
      assertEquals(calls.length, 2);
    } finally {
      Deno.env.set("PATH", path);
      await Deno.remove(dir, { recursive: true });
    }
  },
});
