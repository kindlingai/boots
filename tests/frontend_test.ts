// The engine/frontend split: events, progress and the TUI's pieces.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type EngineEvent,
  fmtDuration,
  type Frontend,
  Progress,
  progressText,
  setFrontend,
} from "../src/frontend.ts";
import { bot, wrap } from "../src/frontends/tui.ts";
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
