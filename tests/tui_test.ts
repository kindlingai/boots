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

Deno.test("active goals show under the status line, titles only, at most two", () => {
  const t = new TuiFrontend({ title: "test", onInterrupt() {} });
  const before = frame(t);
  t.emit({ type: "busy", label: "thinking" });
  t.emit({ type: "goals", titles: ["Serve GLM", "Mentat router", "Benchmark"] });
  const rows = frame(t);
  assertEquals(rows.length, 24, "still fills the screen exactly");
  const at = rows.findLastIndex((r) => r?.includes("thinking..."));
  assert(at > 0);
  assertEquals(rows[at + 1].trim(), "◆ Serve GLM");
  assertEquals(rows[at + 2].trim(), "◆ Mentat router (+1 more)");
  assertEquals(before.length, 24);
  t.emit({ type: "goals", titles: [] });
  assert(!frame(t).some((r) => r?.includes("◆")));
});
