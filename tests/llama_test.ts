import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { dirSize } from "../src/llama.ts";

Deno.test("dirSize counts files in nested directories, and 0 for a missing one", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "a", "b"), { recursive: true });
  await Deno.writeFile(join(dir, "x"), new Uint8Array(1000));
  await Deno.writeFile(join(dir, "a", "b", "y.downloadInProgress"), new Uint8Array(234));
  assertEquals(await dirSize(dir), 1234);
  assertEquals(await dirSize(join(dir, "missing")), 0);
  await Deno.remove(dir, { recursive: true });
});
