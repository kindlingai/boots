import { assertEquals } from "@std/assert";
import { SecretStore, where } from "../src/secrets.ts";

Deno.test("sudo falls back to the same box's ssh password", () => {
  const s = new SecretStore();
  s.set(["admin@a"], "ssh", "pw-a");
  assertEquals(s.lookup(["admin@a"], "sudo"), "pw-a");
  assertEquals(s.lookup(["admin@a", "root@b"], "sudo"), undefined);
  s.set(["admin@a"], "sudo", "sudo-a");
  assertEquals(s.lookup(["admin@a"], "sudo"), "sudo-a");
  assertEquals(s.lookup(["admin@a"], "ssh"), "pw-a");
});

Deno.test("forget removes a subtree", () => {
  const s = new SecretStore();
  s.set([], "sudo", "l");
  s.set(["a"], "ssh", "1");
  s.set(["a", "b"], "ssh", "2");
  s.set(["ab"], "ssh", "3");
  assertEquals(s.forget("a"), 2);
  assertEquals(s.keys(), ["ab > ssh", "local > sudo"]);
  assertEquals(where([]), "local");
});
