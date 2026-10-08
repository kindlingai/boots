// Themes (src/theme.ts): the CSS-like syntax, how a theme becomes terminal
// codes and the GUI's stylesheet, the built-in ones, switching and keeping
// one, and /screenshot over the GUI's socket.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  allThemes,
  compileGui,
  compileTui,
  guiCss,
  lineTheme,
  loadSavedTheme,
  parseTheme,
  setTheme,
  sgrOf,
  themeCommand,
  themeName,
  tuiColor,
  tuiTheme,
} from "../src/theme.ts";
import { BUILT_IN } from "../src/themes.ts";
import { GuiFrontend } from "../src/frontends/gui.ts";
import { page } from "../src/frontends/gui_page.ts";
import { pngSize, shotName } from "../src/screenshot.ts";

const E = "\x1b[";

Deno.test("theme: the syntax (comments, lists, @media, @extends, quotes, warnings)", () => {
  const t = parseTheme(
    "t",
    `/* a comment; with { braces } */
    @extends default;
    @description "semi; colons, and commas";
    warn, error { color: #ff0000; font-weight: bold }
    assistant.mark { content: "→ "; }
    @media gui { bubble { border: 2px dashed #ff0; font-family: "Comic Sans MS", cursive; } }
    @media tui { bubble { color: red; } }
    @media fax { bubble { color: blue; } }
    nonsense { color: red; }
    ok { colour red; }`,
  );
  assertEquals(t.extends, "default");
  assertEquals(t.description, "semi; colons, and commas");
  assertEquals(t.all.get("warn"), { color: "#ff0000", "font-weight": "bold" });
  assertEquals(t.all.get("error"), t.all.get("warn"));
  assertEquals(t.all.get("assistant.mark"), { content: '"→ "' });
  assertEquals(t.gui.get("bubble")?.["font-family"], '"Comic Sans MS", cursive');
  assertEquals(t.tui.get("bubble"), { color: "red" });
  assertEquals(t.warnings.length, 3, t.warnings.join(" | "));
  assert(t.warnings.some((w) => w.includes("@media fax")));
  assert(t.warnings.some((w) => w.includes('"nonsense"')));
  assert(t.warnings.some((w) => w.includes("colour red")));
});

Deno.test("theme: every built-in theme reads cleanly and extends one that exists", async () => {
  const all = await allThemes();
  for (const name of Object.keys(BUILT_IN)) {
    const t = all.get(name)!;
    assertEquals(t.warnings, [], name);
    assert(t.description, `${name} says what it is`);
    if (name !== "default") assert(all.has(t.extends!), `${name} extends ${t.extends}`);
    // Each compiles for both, and the GUI's never leaves its style element.
    compileTui(t, all, true);
    compileTui(t, all, false);
    assert(!/[<>]/.test(compileGui(t, all)), name);
  }
});

Deno.test("theme: the default is the look as it was (terminal codes, GUI colours)", async () => {
  const all = await allThemes();
  const d = compileTui(all.get("default")!, all, true);
  const want: Record<string, string> = {
    header: "7",
    goal: "33",
    bubble: "36",
    "bubble.frame": "36",
    "bubble.tail": "36",
    "bot.body": "90",
    "bot.eyes": "97",
    "bot.boots": "94",
    "bot.sweat": "96",
    "bot.signal": "31",
    rule: "2",
    dim: "2",
    info: "2",
    status: "2",
    spinner: "36",
    user: "1",
    assistant: "36",
    "assistant.mark": "36",
    warn: "33",
    error: "31",
    ok: "32",
    bold: "1",
    prompt: "1",
    text: "",
  };
  for (const [role, sgr] of Object.entries(want)) assertEquals(d.sgr(role), sgr, role);
  assertEquals(d.content("assistant.mark", "?"), "● ");
  assertEquals(d.content("user.mark", "?"), "› ");
  assertEquals(d.remap(`${E}31mroot${E}0m`), `${E}31mroot${E}0m`, "red stays red");
  assertEquals(d.onBase(`a${E}0mb`), `a${E}0mb`, "no background: rows untouched");
  const css = compileGui(all.get("default")!, all);
  for (
    const rule of [
      "html, body { color: #d8dde4; background: #121417;",
      "#bubble { color: #5fd7e8; border: 1px solid #5fd7e8; border-radius: 10px; }",
      "#speech::before { border-right-color: #5fd7e8; }",
      "#bot .b { color: #4aa8ff; }",
      ".a31 { color: #ef6b73; }",
      ".user { color: #c6a0f6; }",
      '.assistant::before { color: #5fd7e8; content: "● "; }',
      "header, #top, #status, #goal, form { border-color: #2a2f37; }",
    ]
  ) assertStringIncludes(css, rule);
  assert(!css.includes("inverse"), "terminal-only properties stay out of the GUI");
  assert(!css.includes("default"), "the terminal's own colour is no colour in the GUI");
});

Deno.test("theme: colours for a terminal (names, hex, rgb(), 24-bit or 256)", () => {
  assertEquals(tuiColor("cyan"), "36");
  assertEquals(tuiColor("bright-blue", true), "104");
  assertEquals(tuiColor("default"), "");
  assertEquals(tuiColor("#ff8000", false, true), "38;2;255;128;0");
  assertEquals(tuiColor("#f80", true, true), "48;2;255;136;0");
  assertEquals(tuiColor("rgb(0, 43, 54)", false, true), "38;2;0;43;54");
  assertEquals(tuiColor("orange", false, true), "38;2;255;165;0");
  assertEquals(tuiColor("#000000", false, false), "38;5;16");
  assertEquals(tuiColor("#ffffff", false, false), "38;5;231");
  assertEquals(tuiColor("#808080", false, false), "38;5;244");
  assertEquals(tuiColor("not-a-colour"), null);
  assertEquals(
    sgrOf({
      color: "red",
      background: "1px solid blue",
      "font-weight": "700",
      "font-style": "italic",
      "text-decoration": "underline",
      opacity: ".5",
      inverse: "on",
    }),
    "1;2;3;4;7;31;44",
  );
});

Deno.test("theme: var() with fallbacks, @extends chains, and @media order", async () => {
  const all = await allThemes();
  const parent = parseTheme("p", `:root { --a: red; } warn { color: var(--a); }`);
  const child = parseTheme(
    "c",
    `@extends p; :root { --a: #00ff00; } error { color: var(--missing, blue); }
     @media tui { :root { --a: yellow; } }`,
  );
  all.set("p", parent);
  all.set("c", child);
  const t = compileTui(child, all, true);
  assertEquals(t.sgr("warn"), "33", "the child's var, its @media last");
  assertEquals(t.sgr("error"), "34", "a fallback");
  assertStringIncludes(compileGui(child, all), ".warn { color: #00ff00; }");
  // A loop of @extends ends.
  all.set("x", parseTheme("x", "@extends y; warn { color: red; }"));
  all.set("y", parseTheme("y", "@extends x; ok { color: green; }"));
  assertEquals(compileTui(all.get("x")!, all, true).sgr("warn"), "31");
});

Deno.test("theme: a background fills the terminal, and its colours replace the ANSI ones", async () => {
  const all = await allThemes();
  const s = compileTui(all.get("solarized")!, all, true);
  const base = "38;2;147;161;161;48;2;0;43;54";
  assertEquals(s.base, base);
  assertEquals(
    s.onBase(`a${E}31mb${E}0mc${E}39md`),
    `${E}${base}ma${E}31mb${E}0;${base}mc${E}38;2;147;161;161md`,
    "resets go back to the theme, not the terminal",
  );
  assertEquals(s.remap(`${E}1;31m#${E}0m`), `${E}1;38;2;220;50;47m#${E}0m`);
  assertEquals(
    s.remap(`${E}38;5;31mx`),
    `${E}38;5;31mx`,
    "a 256-colour number is not a colour code",
  );
});

Deno.test("theme: the GUI's stylesheet keeps out what could escape it", async () => {
  const all = await allThemes();
  const t = parseTheme(
    "bad",
    `bubble { color: red</style><script>alert(1)</script>; background: blue; }
     warn { color: red } } body { color: red; }`,
  );
  const css = compileGui(t, all);
  assert(!css.includes("<"), css);
  assertStringIncludes(css, "#bubble { background:");
});

Deno.test("theme: /theme lists, switches, keeps the choice, and reads the user's own", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("AIBOOT_HOME", dir);
  try {
    const list = await themeCommand("");
    for (const n of Object.keys(BUILT_IN)) assertStringIncludes(list, n);
    assertStringIncludes(list, "* default");
    assertStringIncludes(await themeCommand("nope"), 'no theme "nope"');

    let heard = 0;
    const { onTheme } = await import("../src/theme.ts");
    const off = onTheme(() => heard++);
    assertStringIncludes(await themeCommand("Paper"), "theme: paper");
    assertEquals(themeName(), "paper");
    assertEquals(heard, 1, "frontends hear of it");
    assertStringIncludes(guiCss(), "#fbf7ee");
    assert(tuiTheme().base.includes("48;"), "paper fills the terminal");
    assertEquals(
      lineTheme().sgr("assistant.mark"),
      "36",
      "but the line interface keeps to the default",
    );
    assertEquals(JSON.parse(await Deno.readTextFile(join(dir, "theme.json"))), { name: "paper" });

    // The user's own, with what it got wrong.
    await Deno.mkdir(join(dir, "themes"));
    await Deno.writeTextFile(
      join(dir, "themes", "Mine.css"),
      `@extends default; @description "mine"; bubble { color: hotpink; } bubbel { color: red; }`,
    );
    assertStringIncludes(await themeCommand(""), `mine  `);
    const said = await themeCommand("mine");
    assertStringIncludes(said, "theme: mine (mine)");
    assertStringIncludes(said, 'unknown role "bubbel"');
    assertEquals(tuiTheme().sgr("bubble"), tuiColor("hotpink")!);
    off();

    // Kept for next time; AIBOOT_THEME overrides it.
    await setTheme("default", false);
    await loadSavedTheme();
    assertEquals(themeName(), "mine");
    Deno.env.set("AIBOOT_THEME", "comic");
    await loadSavedTheme();
    assertEquals(themeName(), "comic");
  } finally {
    Deno.env.delete("AIBOOT_THEME");
    await setTheme("default", false);
    Deno.env.delete("AIBOOT_HOME");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gui: the page starts in the theme, hears of a new one, and sends screenshots", async () => {
  assertStringIncludes(page("t", "x", "#bubble { color: red; }"), "#bubble { color: red; }");
  const g = new GuiFrontend({ title: "t" });
  g.serve();
  try {
    await assertRejects(() => g.screenshot(), Error, "no window open");
    const ws = new WebSocket(g.url.replace("http://", "ws://").replace("/?t=", "/ws?t="));
    const msgs: any[] = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      msgs.push(m);
      // The page's side: a 1×1 PNG for a screenshot.
      if (m.t === "shot") {
        ws.send(JSON.stringify({
          t: "shot",
          id: m.id,
          data:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        }));
      }
    };
    await new Promise((ok) => (ws.onopen = ok));
    const png = await g.screenshot();
    assertEquals(pngSize(png), { width: 1, height: 1 });
    await setTheme("synthwave", false);
    for (let i = 0; i < 40 && !msgs.some((m) => m.t === "theme"); i++) {
      await new Promise((ok) => setTimeout(ok, 25));
    }
    assertStringIncludes(msgs.find((m) => m.t === "theme").css, "linear-gradient");
    ws.close();
  } finally {
    await setTheme("default", false);
    g.close();
  }
});

Deno.test("screenshot: names and sizes", () => {
  assertEquals(shotName(new Date(2026, 9, 8, 14, 5, 1)), "boots-20261008-140501.png");
  assertEquals(pngSize(new Uint8Array([1, 2, 3])), null);
});

Deno.test("theme: the example in docs/themes.md reads cleanly", async () => {
  const doc = await Deno.readTextFile(new URL("../docs/themes.md", import.meta.url));
  const css = doc.match(/```css\n([\s\S]*?)```/)![1];
  const t = parseTheme("ocean", css);
  assertEquals(t.warnings, []);
  assertEquals(t.extends, "default");
  const all = await allThemes();
  assertEquals(compileTui(t, all, true).sgr("bubble"), "38;2;63;208;176");
  assertStringIncludes(compileGui(t, all), "border-radius: 18px");
});
