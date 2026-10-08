// read_file's narrower reads (src/readask.ts): a range, a pattern, and ask,
// a question put to a separate reading of the file in overlapping windows.
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  ASK_PROMPT,
  askFile,
  type Line,
  numbered,
  selectLines,
  toRegex,
  windows,
} from "../src/readask.ts";
import { Session } from "../src/tools.ts";
import { Router } from "../src/llm.ts";
import { Memory } from "../src/memory.ts";
import { McpManager } from "../src/mcp.ts";

const LOG = Array.from(
  { length: 100 },
  (_, i) => i % 10 === 9 ? `ERROR line ${i + 1} failed` : `info line ${i + 1}`,
).join("\n") + "\n";

Deno.test("readask: patterns as plain, (?i) and /re/flags", () => {
  assert(toRegex("(?i)cuda").test("CUDA out of memory"));
  assert(toRegex("/out of (\\w+)/i").test("Out of memory"));
  assert(!toRegex("cuda").test("CUDA"));
  assertThrows(() => toRegex("(unclosed"));
});

Deno.test("readask: lines by range and pattern, with context, numbered with gaps", () => {
  assertEquals(selectLines(LOG).lines.length, 100, "the final newline is not a line");
  assertEquals(selectLines(LOG).what, "all 100 lines");
  const r = selectLines(LOG, { start_line: 5, end_line: 12 });
  assertEquals(r.lines.map((l) => l.n), [5, 6, 7, 8, 9, 10, 11, 12]);
  assertEquals(r.what, "lines 5-12 of 100");
  const p = selectLines(LOG, { pattern: "ERROR", end_line: 30 });
  assertEquals(p.lines.map((l) => l.n), [10, 20, 30]);
  assertEquals(p.what, "lines 1-30 of 100, matching /ERROR/ (3 matches)");
  const c = selectLines(LOG, { pattern: "ERROR", context: 1, start_line: 15, end_line: 25 });
  assertEquals(c.lines.map((l) => l.n), [19, 20, 21]);
  assertEquals(
    numbered(selectLines(LOG, { pattern: "ERROR", end_line: 20, context: 1 }).lines),
    " 9| info line 9\n10| ERROR line 10 failed\n11| info line 11\n    ...\n19| info line 19\n20| ERROR line 20 failed",
  );
  assertEquals(selectLines(LOG, { start_line: 200 }).lines, []);
});

Deno.test("readask: windows fit the budget, overlap, cover every line, and cut long lines", () => {
  const lines: Line[] = Array.from(
    { length: 500 },
    (_, i) => ({ n: i + 1, text: `x`.repeat(40 + (i % 7)) }),
  );
  const w = windows(lines, 2000);
  assert(w.length > 5);
  for (const c of w) assert(c.text.length <= 2000, `${c.text.length}`);
  assertEquals(w[0].from, 1);
  assertEquals(w.at(-1)!.to, 500);
  for (let i = 1; i < w.length; i++) {
    assert(w[i].from <= w[i - 1].to, "each starts before the last ended");
    assert(w[i].from > w[i - 1].from, "and moves on");
    assert(w[i - 1].to - w[i].from + 1 <= 6, "by about a tenth");
  }
  const long = windows(
    [{ n: 1, text: "a" }, { n: 2, text: "y".repeat(5000) }, { n: 3, text: "b" }],
    1000,
  );
  assert(long.length >= 6);
  for (const c of long) assert(c.text.length <= 1000);
  assert(long.every((c) => c.from <= 3));
});

Deno.test("readask: ask reads each window for the question and joins the answers with their lines", async () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `entry ${i + 1}: ${"z".repeat(30)}`).join(
    "\n",
  );
  const sent: { system: string; user: string }[] = [];
  const progress: string[] = [];
  const out = await askFile({
    path: "/var/log/big.log",
    question: "what failed?",
    sel: selectLines(lines),
    contextChars: 40_000,
    answer: (system, user) => {
      sent.push({ system, user });
      const m = user.match(/This part: lines (\d+)-(\d+)/)!;
      return Promise.resolve(`<think>hmm</think>saw ${m[1]}-${m[2]}`);
    },
    onProgress: (d, of) => progress.push(`${d}/${of}`),
  });
  assert(sent.length > 1);
  for (const s of sent) {
    assertEquals(s.system, ASK_PROMPT);
    assert(s.system.length + s.user.length <= 30_000, "at most 75% of the context");
    assertStringIncludes(s.user, "Question: what failed?");
    assertStringIncludes(s.user, "File: /var/log/big.log (2000 lines; given here: all 2000 lines)");
  }
  assertStringIncludes(out, `in ${sent.length} overlapping parts) for: what failed?`);
  const ranges = [...out.matchAll(/\[lines (\d+)-(\d+)\]\nsaw (\d+)-(\d+)/g)];
  assertEquals(ranges.length, sent.length, "every answer, under its lines, thinking left out");
  for (const r of ranges) assertEquals([r[1], r[2]], [r[3], r[4]]);
  assertEquals(progress.at(-1), `${sent.length}/${sent.length}`);
});

Deno.test("readask: a window too long for the model is read in halves; other errors are reported", async () => {
  const sel = selectLines(
    Array.from({ length: 300 }, (_, i) => `l${i + 1} ${"q".repeat(50)}`).join("\n"),
  );
  let calls = 0;
  const out = await askFile({
    path: "f",
    question: "q?",
    sel,
    contextChars: 1_000_000,
    answer: (_s, user) => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("context size exceeded"));
      if (user.includes("This part: lines 1-")) return Promise.resolve("found it");
      return Promise.reject(new Error("server down"));
    },
    tooLong: (e) => /context size/.test((e as Error).message),
  });
  assert(calls >= 3, `${calls}`);
  assertStringIncludes(out, "[lines 1-300]\nlines 1-");
  assertStringIncludes(out, ": found it");
  assertStringIncludes(out, "(not read: server down)");

  const many = await askFile({
    path: "f",
    question: "q?",
    sel,
    contextChars: 4000,
    maxWindows: 2,
    answer: () => Promise.resolve("ok"),
  });
  assertStringIncludes(many, "not read: more than 2 parts. Narrow it");
  assertStringIncludes(
    await askFile({
      path: "f",
      question: "q",
      sel: selectLines("a", { pattern: "zzz" }),
      contextChars: 9000,
      answer: () => Promise.resolve(""),
    }),
    "nothing to read in f",
  );
});

Deno.test("read_file: range and pattern come back numbered; ask goes to a fresh request", async () => {
  const bodies: any[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const body = await req.json();
    bodies.push(body);
    const user = body.messages.at(-1).content as string;
    const m = user.match(/This part: lines (\d+)-(\d+)/);
    const content = m ? `the errors in ${m[1]}-${m[2]} are at 10 and 20` : "ok";
    const chunk = { choices: [{ delta: { content }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const dir = await Deno.makeTempDir();
  try {
    const s = new Session(
      new Router({
        label: "m",
        baseUrl: `http://127.0.0.1:${server.addr.port}/v1`,
        model: "m",
        contextChars: 40_000,
      }),
      new Memory(join(dir, "mem")),
      new McpManager(join(dir, "mcp.json")),
      () => Promise.resolve(null),
    );
    await s.init();
    const path = join(dir, "server.log");
    await Deno.writeTextFile(path, LOG);
    const range = await s.exec("read_file", { path, start_line: 98 });
    assertStringIncludes(
      range,
      "lines 98-100 of 100\n 98| info line 98\n 99| info line 99\n100| ERROR line 100 failed",
    );
    const matched = await s.exec("read_file", { path, pattern: "(?i)error", end_line: 25 });
    assertStringIncludes(matched, "10| ERROR line 10 failed\n    ...\n20| ERROR line 20 failed");
    assertStringIncludes(
      await s.exec("read_file", { path, pattern: "(" }),
      "not a regular expression",
    );
    assertEquals(bodies.length, 0, "no model for a plain read");

    const asked = await s.exec("read_file", {
      path,
      ask: "where are the errors?",
      pattern: "ERROR",
      context: 1,
    });
    assertEquals(bodies.length, 1);
    assertEquals(bodies[0].tools, undefined, "a fresh request: no tools");
    assertEquals(bodies[0].messages.length, 2, "and no history");
    assertEquals(bodies[0].messages[0].content, ASK_PROMPT);
    assertStringIncludes(bodies[0].messages[1].content, "Question: where are the errors?");
    assertStringIncludes(bodies[0].messages[1].content, " 10| ERROR line 10 failed");
    assert(!bodies[0].messages[1].content.includes("info line 50"), "only the lines picked");
    assertStringIncludes(asked, "Answers from a separate reading of");
    assertStringIncludes(
      asked,
      "matching /ERROR/ with 1 line around (10 matches)) for: where are the errors?",
    );
    assertStringIncludes(asked, "[lines 9-100]\nthe errors in 9-100 are at 10 and 20");
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
