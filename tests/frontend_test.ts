// The engine/frontend split: events, progress and the TUI's pieces.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  botName,
  type EngineEvent,
  fmtDuration,
  type Frontend,
  Progress,
  progressText,
  setFrontend,
} from "../src/frontend.ts";
import { bot, paintBot, wrap } from "../src/frontends/tui.ts";
import { approve, choose, say, spinner } from "../src/ui.ts";

/** A frontend that records events and answers prompts from a list. */
class Recorder implements Frontend {
  events: EngineEvent[] = [];
  prompts: string[] = [];
  constructor(private answers: string[] = []) {}
  emit(e: EngineEvent) {
    this.events.push(e);
  }
  readLine(prompt: string) {
    this.prompts.push(prompt);
    return Promise.resolve(this.answers.shift() ?? null);
  }
  close() {}
}

Deno.test("the engine talks to whichever frontend is installed", async () => {
  const r = new Recorder(["x", "a", "2"]);
  setFrontend(r);
  say("hello", "ok");
  const s = spinner("thinking");
  s.stop();
  s.stop();
  assertEquals(r.events, [
    { type: "line", text: "hello", style: "ok" },
    { type: "busy", label: "thinking" },
    { type: "busy", label: null },
  ]);
  // Prompts are built on readLine, so every frontend gets them for free.
  assertEquals(await approve("rm -rf /tmp/x"), { ok: true, always: true });
  assertEquals(r.prompts.length, 2, "an unknown answer asks again");
  assertEquals(await choose("pick", ["a", "b"]), 1);
});

Deno.test("progress: throttled, with a smoothed rate, a bar and an ETA", async () => {
  const r = new Recorder();
  setFrontend(r);
  const p = new Progress("dl", "downloading", 1000);
  p.update(100);
  p.update(200); // within 250 ms: dropped
  assertEquals(r.events.length, 1);
  await new Promise((res) => setTimeout(res, 600));
  p.update(400);
  const last = r.events.at(-1) as Extract<EngineEvent, { type: "progress" }>;
  assertEquals(last.done, 400);
  assert(last.rate! > 0);
  p.end(true, "done");
  p.update(500); // after the end: nothing
  assertEquals(r.events.at(-1), { type: "progress-end", id: "dl", ok: true, text: "done" });
  const text = progressText({
    type: "progress",
    id: "x",
    label: "dl",
    done: 6.5e9,
    total: 13e9,
    rate: 25e6,
  }, 10);
  assertEquals(text, "[█████░░░░░]  50%  6.50 GB/13.00 GB  25.0 MB/s  ETA 4m 20s");
  assertEquals(
    progressText({ type: "progress", id: "x", label: "l", done: 0, note: "loading the model" }),
    "loading the model",
  );
  assertEquals(fmtDuration(3725), "1h 02m");
});

Deno.test("tui: wrapping and the bot", () => {
  assertEquals(wrap("the quick brown fox jumps", 10), ["the quick", "brown fox", "jumps"]);
  assertEquals(wrap("abcdefghijklmno", 5), ["abcde", "fghij", "klmno"]);
  assertEquals(wrap("a\n\nb", 5), ["a", "", "b"]);
  const idle = bot("idle", 0, false);
  assertEquals(idle.length, 6);
  assert(idle.every((l) => l.length === 9), "every row is 9 columns");
  assertStringIncludes(idle[2], "| o o |");
  assertStringIncludes(bot("idle", 0, true)[2], "| - - |");
  assertStringIncludes(bot("sad", 0, false)[2], "| x x |");
  assertStringIncludes(bot("talking", 1, false)[3], "+--o--+");
  assertStringIncludes(bot("asking", 0, false)[0], "?");
});

Deno.test("tui: the bot's colours", () => {
  const E = String.fromCharCode(27);
  const idle = paintBot(bot("idle", 0, false));
  assert(idle[0].startsWith(`${E}[90m`), "a plain antenna is grey");
  assert(paintBot(bot("asking", 0, false))[0].startsWith(`${E}[31m`), "a signalling one dark red");
  assert(paintBot(bot("thinking", 1, false))[0].startsWith(`${E}[31m`));
  assertStringIncludes(idle[1], `${E}[90m+-----+${E}[0m`, "grey body");
  assertStringIncludes(idle[2], `${E}[97m o o ${E}[0m`);
  assert(idle[5].startsWith(`${E}[94m`), "bright blue boots");
  const plain = (s: string) => s.replace(new RegExp(E + "\\[[0-9;]*m", "g"), "");
  assertEquals(idle.map(plain), bot("idle", 0, false), "colour adds nothing visible");
});

Deno.test("tui: the bot sweats while it works, and only then", () => {
  const frames = Array.from({ length: 8 }, (_, f) => bot("working", f, false));
  for (const art of frames) assert(art.every((l) => l.length === 9), art.join("|"));
  // A drop on each side, moving: no two neighbouring frames look the same.
  const drops = frames.map((a) => a.slice(1, 4).map((l) => l[0] + l[8]).join(""));
  assert(drops.every((d) => d.trim()), "a drop is always showing");
  for (let i = 1; i < drops.length; i++) {
    assert(drops[i] !== drops[i - 1] || frames[i][5] !== frames[i - 1][5]);
  }
  assert(drops.some((d) => d.includes("'")) && drops.some((d) => d.includes(",")));
  for (const m of ["idle", "thinking", "talking", "happy", "sad", "asking"] as const) {
    for (let f = 0; f < 8; f++) {
      const a = bot(m, f, false);
      assertEquals(
        a.slice(1, 4).map((l) => l[0] + l[8]).join("").trim(),
        "",
        `${m} does not sweat`,
      );
    }
  }
  const E = String.fromCharCode(27);
  assertStringIncludes(paintBot(frames[0])[1], `${E}[96m'${E}[0m`, "light blue drops");
});

Deno.test("the bot is lil boots, and Boots on the full model", () => {
  assertEquals(botName(), "lil boots");
  assertEquals(botName(false), "lil boots");
  assertEquals(botName(true), "Boots");
});

Deno.test("the TUI is chosen for modern terminals only", async () => {
  const { modernTerminal } = await import("../src/main.ts");
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  for (
    const term of ["xterm-256color", "screen", "tmux-256color", "xterm-kitty", "alacritty", "linux"]
  ) {
    assert(modernTerminal(env({ TERM: term })), term);
  }
  assert(modernTerminal(env({ WT_SESSION: "x" })), "Windows Terminal");
  assert(modernTerminal(env({ TERM_PROGRAM: "iTerm.app", TERM: "" })));
  assert(!modernTerminal(env({ TERM: "dumb", TERM_PROGRAM: "x" })));
  assert(!modernTerminal(env({ TERM: "vt100" })));
  assert(!modernTerminal(env({})));
});

Deno.test("Esc twice within 2 s counts, once or slower does not", async () => {
  const { doubleEsc } = await import("../src/frontend.ts");
  let t = 0;
  const esc = doubleEsc(() => t);
  assertEquals(esc(), false);
  t = 1500;
  assertEquals(esc(), true, "second within 2 s");
  t = 1600;
  assertEquals(esc(), false, "a third starts over");
  t = 4000;
  assertEquals(esc(), false, "too slow");
  t = 4100;
  assertEquals(esc(), true);
});

Deno.test("the GUI is opt-in: --gui or AIBOOT_UI=gui, never chosen on its own", async () => {
  const { uiMode } = await import("../src/main.ts");
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assertEquals(uiMode("--gui", env({}), false), "gui");
  assertEquals(uiMode(undefined, env({ AIBOOT_UI: "gui" }), true), "gui");
  assertEquals(uiMode(undefined, env({ TERM: "xterm-256color" }), true), "tui");
  assertEquals(uiMode(undefined, env({ TERM: "xterm-256color" }), false), "repl");
  assertEquals(uiMode("--repl", env({ AIBOOT_UI: "gui" }), true), "repl");
  assertEquals(uiMode(undefined, env({ AIBOOT_UI: "repl", TERM: "xterm" }), true), "repl");
});
