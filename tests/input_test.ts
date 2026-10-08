// Typing: a draft survives a trip through the history; /commands typed while
// the model works run at once (or wait, if they need it); the model's words
// stand apart from the commands around them.
import { assert, assertEquals } from "@std/assert";
import { TuiFrontend } from "../src/frontends/tui.ts";
import { setCommandHandler, steer, takeSteering } from "../src/frontend.ts";

function frame(t: TuiFrontend): string[] {
  let out = "";
  (t as any).out = (s: string) => (out = s);
  (t as any).size = () => ({ w: 80, h: 30 });
  t.render();
  const E = String.fromCharCode(27);
  const ansi = new RegExp(E + "\\[[0-9;?]*[A-Za-z]", "g");
  const parts = out.split(new RegExp(E + "\\[(\\d+);1H" + E + "\\[2K"));
  const rows: string[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    rows[Number(parts[i]) - 1] = parts[i + 1].replace(ansi, "");
  }
  return rows;
}

Deno.test("tui: ↑ keeps what was typed; ↓ past the newest brings it back", () => {
  const t = new TuiFrontend({ title: "t", onInterrupt() {} });
  const keys = (s: string) => t.feed([...new TextEncoder().encode(s)]);
  (t as any).history = ["first", "second"];
  keys("half typ");
  keys("\x1b[A");
  assertEquals((t as any).buf, "second");
  keys("\x1b[A");
  assertEquals((t as any).buf, "first");
  keys("\x1b[B");
  keys("\x1b[B");
  assertEquals((t as any).buf, "half typ", "the draft is back");
  keys("\x1b[B");
  assertEquals((t as any).buf, "half typ", "↓ with nothing browsed changes nothing");
});

Deno.test("steer: a /command goes to the handler at once; text is queued", () => {
  const ran: string[] = [];
  setCommandHandler((t) => ran.push(t));
  try {
    assertEquals(steer("/theme comic"), "command");
    assertEquals(steer("check the logs"), "queued");
    assertEquals(steer("/playbook result", false), "queued", "unless asked not to");
    assertEquals(steer("  "), "empty");
    assertEquals(ran, ["/theme comic"]);
    assertEquals(takeSteering(), ["check the logs", "/playbook result"]);
  } finally {
    setCommandHandler(null);
  }
  assertEquals(steer("/help"), "queued", "no REPL: queued as text");
  takeSteering();
});

Deno.test("commands while the model works: run now, wait for it, or hand it a playbook's result", async () => {
  const { busyCommand, runCommand } = await import("../src/agent.ts");
  const said: string[] = [];
  const { setFrontend } = await import("../src/frontend.ts");
  setFrontend({
    emit(e) {
      if (e.type === "line") said.push(e.text);
    },
    readLine: () => Promise.resolve(null),
    close() {},
  });
  const execs: [string, any][] = [];
  const agent: any = {
    s: {
      exec: (
        name: string,
        args: any,
      ) => (execs.push([name, args]), Promise.resolve("playbook x: exit 0\nup")),
      memory: { playbooks: () => Promise.resolve([]) },
    },
  };
  await busyCommand(agent, "/help");
  assert(said.some((l) => l.startsWith("commands:")), "ran at once");
  await busyCommand(agent, "/compact");
  assert(said.at(-1)!.includes("/compact runs when the model is done"));
  takeSteering();
  await busyCommand(agent, "/playbook x up");
  assertEquals(execs, [["run_playbook", { name: "x", args: ["up"] }]]);
  const q = takeSteering();
  assertEquals(q.length, 1);
  assert(
    q[0].startsWith(
      "(The user ran the playbook x up with /playbook. Its result:)\nplaybook x: exit 0",
    ),
  );
  // At the prompt: the result starts the model's turn.
  const r = await runCommand(agent, "/playbook x");
  assert(r && r !== "quit" && r.turn.includes("Its result:"));
});

Deno.test("tui: the model's words have a blank line before and after", () => {
  const t = new TuiFrontend({ title: "t", onInterrupt() {} });
  t.emit({ type: "line", text: "local $ uptime" });
  t.emit({ type: "assistant", phase: "start" });
  t.emit({ type: "assistant", phase: "delta", text: "Checking the GPUs next." });
  t.emit({ type: "assistant", phase: "end" });
  t.emit({ type: "line", text: "local $ nvidia-smi" });
  const rows = frame(t).map((r) => r?.trimEnd() ?? "");
  const at = rows.findLastIndex((r) => r.includes("Checking the GPUs"));
  assertEquals(rows.slice(at - 2, at + 3).map((r) => r.trim()), [
    "local $ uptime",
    "",
    "● Checking the GPUs next.",
    "",
    "local $ nvidia-smi",
  ]);
});
