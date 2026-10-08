// Long output cut by whole lines (src/clip.ts): a row per 100 characters,
// head and tail whole, only the line running past the room cut.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { clipLines } from "../src/clip.ts";

Deno.test("clip: short text is left alone", () => {
  assertEquals(clipLines("a\nb", 100), "a\nb");
});

Deno.test("clip: whole lines from the head and tail; a long line costs a row per 100 chars", () => {
  const long = "L".repeat(250); // three rows
  const lines = [
    long,
    ...Array.from({ length: 40 }, (_, i) => `line ${i + 1}`.padEnd(60, ".")),
    "the end",
  ];
  const out = clipLines(lines.join("\n"), 1000).split("\n");
  const bare = (l: string) => l.replace(/\.+$/, "");
  // 10 rows: 5 for the head (the long line is 3, then 2 short ones), 5 for the tail.
  assertEquals(out[0], long, "a long line in the room is kept whole");
  assertEquals(out.slice(1, 3).map(bare), ["line 1", "line 2"]);
  assertStringIncludes(out[3], "...[34 lines (");
  assertEquals(out.slice(4).map(bare), ["line 37", "line 38", "line 39", "line 40", "the end"]);
});

Deno.test("clip: only the line that runs past the room is cut, and says by how much", () => {
  const text = ["short", "X".repeat(800), ...Array.from({ length: 30 }, () => "y")].join("\n");
  const out = clipLines(text, 600, 0.5).split("\n");
  assertEquals(out[0], "short");
  assert(out[1].startsWith("X".repeat(200)), out[1].slice(0, 20));
  assertStringIncludes(out[1], "…[+600 chars]");
  assertStringIncludes(out.join("\n"), "lines (");
});
