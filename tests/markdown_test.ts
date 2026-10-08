// The model's words as Markdown (src/markdown.ts): terminal lines for the TUI,
// HTML for the GUI, plain text for the speech bubble.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { markdownHtml, markdownLines, markdownPlain } from "../src/markdown.ts";
import { page } from "../src/frontends/gui_page.ts";

const E = String.fromCharCode(27);
const plain = (l: string[]) => l.map((x) => x.replace(new RegExp(E + "\\[[0-9;]*m", "g"), ""));
const len = (s: string) => [...s].length;

const TABLE = `| Model | Size | Fits |
|:------|-----:|:----:|
| Qwen3 30B-A3B | 17 GB | yes |
| GLM-5.3 Flash | 62 GB | **no** |`;

Deno.test("markdown: a table is drawn in a box, aligned, within the width", () => {
  const l = plain(markdownLines(TABLE, 60));
  assertEquals(l, [
    "┌───────────────┬───────┬──────┐",
    "│ Model         │  Size │ Fits │",
    "├───────────────┼───────┼──────┤",
    "│ Qwen3 30B-A3B │ 17 GB │ yes  │",
    "│ GLM-5.3 Flash │ 62 GB │  no  │",
    "└───────────────┴───────┴──────┘",
  ]);
  // Narrower: cells wrap, every line still fits.
  const narrow = plain(
    markdownLines(TABLE + "\n| x | a long note that must wrap somewhere | y |", 30),
  );
  for (const x of narrow) assert(len(x) <= 30, x);
  assert(narrow.length > 7);
  // Far too narrow for the columns: one line per row, cells named by their headers.
  const list = plain(markdownLines(TABLE, 12));
  assertEquals(list[0], "• Model:");
});

Deno.test("markdown: lists, tasks, headings, quotes, code and rules", () => {
  const l = plain(markdownLines(
    [
      "# Plan",
      "1. Stop it",
      "2. Get the weights, which takes a while on a slow disk",
      "   - `hf download x`",
      "- [x] done",
      "- [ ] open",
      "> careful",
      "```sh",
      "docker run x",
      "```",
      "---",
      "snake_case_name and 2*3*4 stay as they are",
    ].join("\n"),
    30,
  ));
  assertEquals(l, [
    "Plan",
    "1. Stop it",
    "2. Get the weights, which",
    "   takes a while on a slow",
    "   disk",
    "  ◦ hf download x",
    "☑ done",
    "☐ open",
    "│ careful",
    "  docker run x",
    "─".repeat(30),
    "snake_case_name and 2*3*4 stay",
    "as they are",
  ]);
});

Deno.test("markdown: styles keep the base colour (no reset to the terminal's)", () => {
  const [line] = markdownLines("a **b** `c` d", 40, "36");
  assertEquals(line, `${E}[0;36ma ${E}[0;36;1mb${E}[0;36m ${E}[0;36;2mc${E}[0;36m d${E}[0m`);
});

Deno.test("markdown: HTML for the GUI is escaped, with tables and nested lists", () => {
  const h = markdownHtml(
    `<script>alert(1)</script> **b** \`<i>\`\n\n${TABLE}\n- a\n  - b\n1. one\n\n\`\`\`\n<x>\n\`\`\``,
  );
  assert(!h.includes("<script>"), h);
  assertStringIncludes(h, "&lt;script&gt;alert(1)&lt;/script&gt; <b>b</b> <code>&lt;i&gt;</code>");
  assertStringIncludes(h, '<th style="text-align:right">Size</th>');
  assertStringIncludes(h, '<td style="text-align:center"><b>no</b></td>');
  assertStringIncludes(h, "<ul><li>a</li><ul><li>b</li></ul></ul><ol><li>one</li></ol>");
  assertStringIncludes(h, "<pre>&lt;x&gt;</pre>");
});

Deno.test("markdown: plain text for the bubble", () => {
  assertEquals(
    markdownPlain("Go with **GLM** (`vllm`)?\n- [ ] x\n- y\n| a | b |\n|---|---|\n| 1 | 2 |"),
    "Go with GLM (vllm)?\n☐ x\n• y\na   b\n1   2",
  );
});

Deno.test("markdown: the page's copies run on their own and agree", () => {
  const script = page("t", "x").match(/<script>([\s\S]*?)const TOKEN/)![1];
  const [html, pl] = new Function(`${script}; return [markdownHtml, markdownPlain];`)();
  const t = `${TABLE}\n- a **b**\n> q`;
  assertEquals(html(t), markdownHtml(t));
  assertEquals(pl(t), markdownPlain(t));
});
