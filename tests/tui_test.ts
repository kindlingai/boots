// The full-screen frontend's layout.
import { assert, assertEquals } from "@std/assert";
import { TuiFrontend } from "../src/frontends/tui.ts";

/** One frame, as rows of plain text. */
function frame(t: TuiFrontend): string[] {
  let out = "";
  (t as any).out = (s: string) => (out = s);
  (t as any).size = () => ({ w: 80, h: 24 });
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

Deno.test("the current goal and its step show at the top, tidied; the bubble too", () => {
  const t = new TuiFrontend({ title: "test", onInterrupt() {} });
  t.emit({ type: "goals", titles: ["  Serve GLM:  ", "Start TP4", "Benchmark"] });
  t.emit({ type: "busy", label: "thinking" });
  t.emit({ type: "activity", text: "  checking rank 2:\n" });
  const rows = frame(t);
  assertEquals(rows.length, 24, "still fills the screen exactly");
  assertEquals(rows[1].trim(), "◆ Serve GLM › Start TP4  (+1 more)", "right under the header");
  const top = rows.slice(0, 9).join("\n");
  assert(top.includes("checking rank 2") && !top.includes("rank 2:"), "no dangling colon");
  t.emit({ type: "goals", titles: [] });
  assert(!frame(t).some((r) => r?.includes("◆")));
});

Deno.test("commands keep their colours in the TUI, wrapped by visible width", async () => {
  const { commandLine, setColor } = await import("../src/ui.ts");
  const { wrapAnsi } = await import("../src/frontend.ts");
  setColor(true);
  const line = commandLine("local > admin@192.168.1.70", "#", "docker ps -a " + "x".repeat(60));
  const E = String.fromCharCode(27);
  const visible = (x: string) => x.replace(new RegExp(E + "\\[[0-9;]*m", "g"), "");
  const w = wrapAnsi(line, 40);
  assert(w.length > 1 && w.every((l) => visible(l).length <= 40));
  assert(w[0].includes(E + "[36m") && w[0].includes(E + "[31m"), "location cyan, # red");
  assertEquals(
    visible(w.join("")).replace(/ /g, ""),
    visible(line).replace(/ /g, ""),
    "no text lost",
  );
  const t = new TuiFrontend({ title: "test", onInterrupt() {} });
  t.emit({ type: "line", text: line });
  let out = "";
  (t as any).out = (s: string) => (out = s);
  (t as any).size = () => ({ w: 80, h: 24 });
  t.render();
  assert(out.includes(E + "[36mlocal > admin@192.168.1.70"), "the TUI keeps the colours");
});

Deno.test('update_status replaces "thinking..." in the bubble while working', () => {
  const t = new TuiFrontend({ title: "test", onInterrupt() {} });
  t.emit({ type: "busy", label: "thinking" });
  t.emit({ type: "activity", text: "rank 2 restarting" });
  const top = frame(t).slice(0, 8).join("\n");
  assert(top.includes("rank 2 restarting"));
  assert(!top.includes("thinking..."));
  t.emit({ type: "activity", text: null });
  assert(frame(t).slice(0, 8).join("\n").includes("thinking..."));
});

Deno.test("typing while the model works: Enter queues it; drafts survive questions; a stop hands text back", async () => {
  const { takeSteering, setPrefill } = await import("../src/frontend.ts");
  const t = new TuiFrontend({ title: "test", onInterrupt() {} });
  (t as any).out = () => {};
  const type = (s: string) => {
    for (const ch of s) {
      (t as any).edit(() => {
        const chars = [...(t as any).buf];
        chars.splice((t as any).cursor, 0, ch);
        (t as any).buf = chars.join("");
        (t as any).cursor++;
      });
    }
  };
  // No prompt open: typed text is a message for the model.
  type("check rank 2 first");
  (t as any).enter();
  assertEquals(takeSteering(), ["check rank 2 first"]);
  // A draft, then an approval opens: set aside, then back.
  type("also look at");
  const q = t.readLine("run it? ", false, [{ key: "y", label: "Yes" }]);
  assertEquals((t as any).buf, "", "the question starts empty");
  (t as any).finish("y");
  await q;
  assertEquals((t as any).buf, "also look at", "the draft is back");
  // The main prompt after a stop: what was handed back, then the draft.
  setPrefill("use port 9000");
  const main = t.readLine("local> ");
  assertEquals((t as any).buf, "use port 9000 also look at");
  (t as any).finish("x");
  await main;
});
