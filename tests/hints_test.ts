// The hints by output in src/hints.json: every entry reads, and each fires
// where it should.
import { assert, assertEquals, assertThrows } from "@std/assert";
import data from "../src/hints.json" with { type: "json" };
import { compileHints, outputHints } from "../src/hints.ts";

Deno.test("hints.json: every entry has a valid output (and command) pattern and a hint", () => {
  const hints = compileHints(data.hints as any);
  assertEquals(hints.length, data.hints.length);
  for (const h of data.hints as any[]) {
    for (const t of h.tools ?? []) assert(["run", "sudo", "run_playbook"].includes(t), t);
  }
  assertThrows(() => compileHints([{ output: "(", hint: "x" }]));
  assertThrows(() => compileHints([{ output: "x", hint: "" }]));
});

Deno.test("hints: by tool, command and output", () => {
  const pw = "sudo: a terminal is required to read the password";
  assert(outputHints("run", "ssh a@b sudo ls", pw)[0].startsWith("sudo on the other machine"));
  assertEquals(outputHints("run", "ls", pw), [], "not without ssh and sudo in the command");
  assert(
    outputHints("run_playbook", "#!/bin/sh\nsudo x", pw)[0].startsWith("sudo in the playbook"),
  );
  const docker =
    "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock";
  for (const t of ["run", "sudo", "run_playbook"] as const) {
    assert(outputHints(t, "docker ps", docker)[0].startsWith("docker refused this login"), t);
  }
  assert(outputHints("run", "x", "listen tcp :8080: bind: address already in use").length);
  assert(outputHints("run", "x", "torch.OutOfMemoryError: CUDA out of memory.").length);
  assertEquals(outputHints("run", "x", "all fine"), []);
});
