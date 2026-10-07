// The GUI frontend over its real WebSocket: the page gets the history and
// state, answers prompts, stops and quits; the page shares the TUI's bot.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { GuiFrontend } from "../src/frontends/gui.ts";
import { page } from "../src/frontends/gui_page.ts";
import { EscInterrupted, setInterruptHandler } from "../src/frontend.ts";

async function connect(g: GuiFrontend) {
  const ws = new WebSocket(g.url.replace("http://", "ws://").replace("/?t=", "/ws?t="));
  const msgs: any[] = [];
  let wake = () => {};
  ws.onmessage = (e) => {
    msgs.push(JSON.parse(e.data));
    wake();
  };
  await new Promise((ok) => (ws.onopen = ok));
  const next = async (t: string, pred: (m: any) => boolean = () => true) => {
    for (let i = 0; i < 100; i++) {
      const at = msgs.findIndex((m) => m.t === t && pred(m));
      if (at >= 0) return msgs.splice(0, at + 1).at(-1);
      await new Promise<void>((ok) => {
        wake = ok;
        setTimeout(ok, 50);
      });
    }
    throw new Error(`no ${t} message`);
  };
  return { ws, next, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

Deno.test("gui: history, prompts, answers, stop and quit over the socket", async () => {
  let quit = 0;
  const g = new GuiFrontend({ title: "ai-bootstrap test", onQuit: () => quit++ });
  g.serve();
  try {
    g.emit({ type: "line", text: "\x1b[2mbooting\x1b[0m\x1b[2K", style: "dim" });
    const c = await connect(g);
    const init = await c.next("init");
    assertEquals(
      init.entries,
      [{ kind: "dim", text: "\x1b[2mbooting\x1b[0m" }],
      "history, colours kept for the page (other escapes dropped)",
    );
    assertEquals(init.state.name, "lil boots");

    // A prompt opens; the page answers it.
    const answered = g.readLine("run it? [y]es [n]o: ");
    const st = (await c.next("state", (m) => m.state.prompt)).state;
    assertEquals(st.prompt.prompt, "run it? [y]es [n]o: ");
    c.send({ t: "answer", id: st.prompt.id, text: "y" });
    assertEquals(await answered, "y");

    // Stop at a prompt cancels it like Esc Esc; with none open it stops what runs.
    const stopped = g.readLine("password: ", true);
    await c.next("state", (m) => m.state.prompt?.hidden);
    c.send({ t: "stop" });
    await assertRejects(() => stopped, EscInterrupted);
    let stops = 0;
    setInterruptHandler((k) => k === "esc" && stops++);
    c.send({ t: "stop" });
    await new Promise((ok) => setTimeout(ok, 100));
    assertEquals(stops, 1);
    setInterruptHandler(() => {});

    // Streaming replies and busy state reach the page.
    g.emit({ type: "assistant", phase: "start" });
    g.emit({ type: "assistant", phase: "delta", text: "Hel" });
    g.emit({ type: "assistant", phase: "delta", text: "lo" });
    assertEquals((await c.next("stream", (m) => m.text === "Hello")).text, "Hello");
    g.emit({ type: "assistant", phase: "end" });
    g.emit({ type: "busy", label: "running ls" });
    assertEquals((await c.next("state", (m) => m.state.busy)).state.busy.label, "running ls");

    // Quit: the open prompt and every later one end (null), and main is told.
    const main = g.readLine("local> ");
    await c.next("state", (m) => m.state.prompt?.prompt === "local> ");
    c.send({ t: "quit" });
    assertEquals(await main, null);
    assertEquals(await g.readLine("again> "), null);
    assertEquals(quit, 1);
    g.close();
    await c.next("bye");
    c.ws.close();
  } finally {
    g.close();
  }
});

Deno.test("gui: the page needs the token, and draws the TUI's own bot", async () => {
  const g = new GuiFrontend({ title: "t" });
  g.serve();
  try {
    const base = g.url.slice(0, g.url.indexOf("?"));
    assertEquals((await fetch(base)).status, 403);
    assertEquals((await fetch(`${base}ws?t=nope`)).status, 403);
    const html = await (await fetch(g.url)).text();
    assertStringIncludes(html, "function bot(");
    assertStringIncludes(html, "function sweat(");
    assertStringIncludes(html, "function moodOf(");
    assert(!html.includes(": Mood"), "shipped as plain JavaScript");
  } finally {
    g.close();
  }
  // The shipped functions run on their own and draw the same bot.
  const { bot } = await import("../src/frontends/bot.ts");
  const script = page("t", "x").match(/<script>([\s\S]*?)const TOKEN/)![1];
  const shipped = new Function(`${script}; return bot;`)();
  for (const m of ["idle", "working", "thinking", "asking"]) {
    for (let f = 0; f < 8; f++) assertEquals(shipped(m, f, false), bot(m as any, f, false));
  }
});

Deno.test("the page's script parses, and handles ⌘V/⌘C/⌘X/⌘A when the macOS window offers its clipboard", async () => {
  const { page } = await import("../src/frontends/gui_page.ts");
  const html = page("t", "tok");
  const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  // A stray escape in the template (a "\n" that became a newline) breaks it all.
  new Function(script);
  assert(script.includes("__aibPaste") && script.includes("__aibCopy"));
});
