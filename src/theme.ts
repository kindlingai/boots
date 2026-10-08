// Themes: how the TUI, the GUI and the line interface look, written in a
// CSS-like syntax (docs/themes.md). A theme gives roles ("bubble", "warn",
// "bot.boots") declarations; the terminal takes color, background,
// font-weight, font-style, text-decoration and opacity from them, and the GUI
// takes every property (borders, fonts, shadows, ...).
//
//   @extends default;
//   :root { --accent: #ff2fd1; }
//   bubble { color: var(--accent); }
//   @media gui { bubble { border: 2px dashed var(--accent); font-family: cursive; } }
//
// The built-in themes are in themes.ts; the user's own are the .css files in
// <data dir>/themes. The one picked (/theme) is kept in <data dir>/theme.json.

import { join } from "@std/path";
import { BUILT_IN } from "./themes.ts";
import { dataDir, ensureDir } from "./platform.ts";

export type Target = "tui" | "gui";
type Decls = Record<string, string>;
type Rules = Map<string, Decls>;

export interface Theme {
  name: string;
  description: string;
  /** "built in", or the file it came from. */
  source: string;
  extends?: string;
  all: Rules;
  tui: Rules;
  gui: Rules;
  /** What could not be read (unknown roles, broken rules). */
  warnings: string[];
}

/** Every role a theme can style, and where the GUI applies it. */
export const ROLES: Record<string, { gui: string; about: string }> = {
  ":root": { gui: "", about: "custom properties (--name: value), for var(--name)" },
  text: { gui: "html, body", about: "everything: text colour, background (fills the TUI), font" },
  panel: { gui: "header, form", about: "the header and input bars (GUI)" },
  header: { gui: "header", about: "the title bar" },
  "header.name": { gui: "header .name", about: "the bot's name in the title bar (GUI)" },
  "header.where": { gui: "header .where", about: "the model and location (GUI)" },
  goal: { gui: "#goal", about: "the current goal, under the title" },
  "goal.step": { gui: "#goal .step", about: "its active step (GUI)" },
  "goal.more": { gui: "#goal .more", about: "the count of other goals (GUI)" },
  bot: { gui: "#bot", about: "the bot as a whole (GUI: its font and size)" },
  "bot.body": { gui: "#bot .g", about: "the bot's body" },
  "bot.eyes": { gui: "#bot .w", about: "its eyes" },
  "bot.boots": { gui: "#bot .b", about: "its boots" },
  "bot.sweat": { gui: "#bot .s", about: "the drops while it works" },
  "bot.signal": { gui: "#bot .r", about: "the antenna when it signals" },
  bubble: { gui: "#bubble", about: "the speech bubble (its border colour draws the TUI frame)" },
  "bubble.tail": { gui: "#speech::before", about: "the bubble's pointer (colour)" },
  rule: { gui: "", about: "the lines between the parts (GUI: border colour)" },
  log: { gui: "#log", about: "the transcript area" },
  assistant: { gui: ".assistant", about: "the model's words" },
  "assistant.mark": { gui: ".assistant::before", about: "the mark before them (content too)" },
  user: { gui: ".user", about: "what the user typed" },
  "user.mark": { gui: ".user::before", about: "the mark before it (content too)" },
  dim: { gui: ".dim", about: "quiet lines" },
  info: { gui: ".info", about: "information lines" },
  warn: { gui: ".warn", about: "warnings" },
  error: { gui: ".error", about: "errors" },
  ok: { gui: ".ok", about: "success" },
  bold: { gui: ".bold", about: "emphasis" },
  red: { gui: ".a31", about: "red in command output and lines (root's #)" },
  green: { gui: ".a32", about: "green in lines" },
  yellow: { gui: ".a33", about: "yellow in lines (the $ sign)" },
  blue: { gui: ".a34", about: "blue in lines" },
  magenta: { gui: ".a35", about: "magenta in lines (the >> of an ssh hop)" },
  cyan: { gui: ".a36", about: "cyan in lines (where a command runs)" },
  status: { gui: "#status", about: "the status line (what runs, the keys)" },
  spinner: { gui: "#status .spin", about: "the spinner" },
  prompt: { gui: "#prompt", about: "the prompt or question" },
  input: { gui: "#input", about: "the input box" },
  "input.focus": { gui: "#input:focus", about: "the input box while typing (GUI)" },
  button: { gui: "button", about: "buttons (GUI)" },
  "button.hover": { gui: "button:hover", about: "a button under the pointer (GUI)" },
  choice: { gui: "button.choice", about: "an answer's button (GUI)" },
  "choice.key": { gui: "button.choice u", about: "its key letter (GUI)" },
  stop: { gui: "#stop", about: "the Stop button (GUI)" },
  quit: { gui: "#quit", about: "the Quit button (GUI)" },
};

/** Where the GUI's lines between parts are. */
const RULED = "header, #top, #status, #goal, form";

// ---- parsing ----

/** Splits on `sep` outside quotes and brackets. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", cur = "";
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** The first `ch` at or after `from` outside quotes, or -1. */
function indexTop(s: string, ch: string, from: number): number {
  let quote = "";
  for (let i = from; i < s.length; i++) {
    if (quote) {
      if (s[i] === quote) quote = "";
    } else if (s[i] === '"' || s[i] === "'") quote = s[i];
    else if (s[i] === ch) return i;
  }
  return -1;
}

/** The index of the brace closing the one at `open`. */
function closing(s: string, open: number): number {
  let depth = 0, quote = "";
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Reads a theme's text. Anything it cannot read becomes a warning. */
export function parseTheme(name: string, text: string, source = "built in"): Theme {
  const t: Theme = {
    name,
    description: "",
    source,
    all: new Map(),
    tui: new Map(),
    gui: new Map(),
    warnings: [],
  };
  const src = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  const block = (s: string, into: Rules) => {
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      const brace = s.indexOf("{", i);
      const semi = indexTop(s, ";", i);
      if (s[i] === "@" && (semi >= 0 && (brace < 0 || semi < brace))) {
        // @extends name;  @description "...";
        const [, at, arg] = s.slice(i, semi).match(/^@([\w-]+)\s*([\s\S]*)$/) ?? [];
        if (at === "extends") t.extends = unquote(arg);
        else if (at === "description") t.description = unquote(arg);
        else t.warnings.push(`unknown @${at}`);
        i = semi + 1;
        continue;
      }
      if (brace < 0) {
        t.warnings.push(`no { after "${s.slice(i).trim().slice(0, 30)}"`);
        break;
      }
      const end = closing(s, brace);
      if (end < 0) {
        t.warnings.push(`no } closing "${s.slice(i, brace).trim()}"`);
        break;
      }
      const head = s.slice(i, brace).trim();
      const body = s.slice(brace + 1, end);
      i = end + 1;
      const media = head.match(/^@media\s+(\w+)$/);
      if (media) {
        const m = media[1].toLowerCase();
        const target = m === "gui" || m === "window"
          ? t.gui
          : m === "tui" || m === "terminal"
          ? t.tui
          : null;
        if (target) block(body, target);
        else t.warnings.push(`unknown @media ${m} (tui or gui)`);
        continue;
      }
      const decls: Decls = {};
      for (const d of splitTop(body, ";")) {
        const c = d.indexOf(":");
        if (!d.trim()) continue;
        const prop = d.slice(0, c).trim().toLowerCase();
        const value = d.slice(c + 1).trim();
        if (c < 0 || !/^-?-?[a-z][a-z0-9-]*$/.test(prop) || !value) {
          t.warnings.push(`cannot read "${d.trim()}" in ${head}`);
          continue;
        }
        decls[prop] = value;
      }
      for (const sel of head.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
        if (!(sel in ROLES)) {
          t.warnings.push(`unknown role "${sel}"`);
          continue;
        }
        into.set(sel, { ...into.get(sel), ...decls });
      }
    }
  };
  block(src, t.all);
  return t;
}

// ---- finding themes ----

export function themesDir(): string {
  return join(dataDir(), "themes");
}

/** The user's .css themes: name → text and path. */
async function userThemes(): Promise<Map<string, { text: string; path: string }>> {
  const out = new Map<string, { text: string; path: string }>();
  try {
    for await (const e of Deno.readDir(themesDir())) {
      if (!e.isFile || !e.name.endsWith(".css")) continue;
      const path = join(themesDir(), e.name);
      try {
        out.set(e.name.slice(0, -4).toLowerCase(), { text: await Deno.readTextFile(path), path });
      } catch {
        // unreadable: left out
      }
    }
  } catch {
    // no themes directory
  }
  return out;
}

/** Every theme by name, the user's over the built-in ones of the same name. */
export async function allThemes(): Promise<Map<string, Theme>> {
  const out = new Map<string, Theme>();
  for (const [n, text] of Object.entries(BUILT_IN)) out.set(n, parseTheme(n, text));
  for (const [n, u] of await userThemes()) out.set(n, parseTheme(n, u.text, u.path));
  return out;
}

// ---- resolving ----

interface Resolved {
  rules: Rules;
  vars: Decls;
}

/** A theme for one target: what it extends first, then its own rules. */
export function resolve(theme: Theme, target: Target, all: Map<string, Theme>): Resolved {
  const chain: Theme[] = [];
  for (let t: Theme | undefined = theme; t && !chain.includes(t); t = all.get(t.extends ?? "")) {
    chain.unshift(t);
    if (!t.extends) break;
  }
  const rules: Rules = new Map();
  for (const t of chain) {
    for (const src of [t.all, t[target]]) {
      for (const [role, d] of src) rules.set(role, { ...rules.get(role), ...d });
    }
  }
  const vars = rules.get(":root") ?? {};
  rules.delete(":root");
  return { rules, vars };
}

/** var(--name, fallback) replaced, nested ones too. */
function subst(value: string, vars: Decls, depth = 0): string {
  if (depth > 8 || !value.includes("var(")) return value;
  return subst(
    value.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
      (_, n, fb) => vars[n] ?? fb?.trim() ?? "default",
    ),
    vars,
    depth + 1,
  );
}

// ---- colours ----

/** The 16 terminal colours, by name: their SGR number, and how the GUI shows them. */
const ANSI_NAMES: Record<string, [number, string]> = {
  black: [30, "#121417"],
  red: [31, "#ef6b73"],
  green: [32, "#8fd19e"],
  yellow: [33, "#e5c07b"],
  blue: [34, "#4aa8ff"],
  magenta: [35, "#d38df0"],
  cyan: [36, "#5fd7e8"],
  white: [37, "#d8dde4"],
  grey: [90, "#8a8f98"],
  gray: [90, "#8a8f98"],
  "bright-black": [90, "#8a8f98"],
  "bright-red": [91, "#ff8a8f"],
  "bright-green": [92, "#a8f0b4"],
  "bright-yellow": [93, "#ffe08a"],
  "bright-blue": [94, "#4aa8ff"],
  "bright-magenta": [95, "#e7a8ff"],
  "bright-cyan": [96, "#8be9fd"],
  "bright-white": [97, "#ffffff"],
};

/** Some CSS colour names, for the terminal (the GUI knows them all). */
const CSS_NAMES: Record<string, string> = {
  orange: "#ffa500",
  gold: "#ffd700",
  pink: "#ffc0cb",
  hotpink: "#ff69b4",
  deeppink: "#ff1493",
  purple: "#800080",
  violet: "#ee82ee",
  orchid: "#da70d6",
  indigo: "#4b0082",
  teal: "#008080",
  turquoise: "#40e0d0",
  navy: "#000080",
  lime: "#00ff00",
  olive: "#808000",
  maroon: "#800000",
  silver: "#c0c0c0",
  coral: "#ff7f50",
  salmon: "#fa8072",
  crimson: "#dc143c",
  tomato: "#ff6347",
  khaki: "#f0e68c",
  ivory: "#fffff0",
  beige: "#f5f5dc",
  chartreuse: "#7fff00",
  skyblue: "#87ceeb",
  steelblue: "#4682b4",
  slategray: "#708090",
};

const NONE = new Set(["default", "inherit", "initial", "unset", "none", "transparent", "auto"]);

function hexRgb(h: string): [number, number, number] | null {
  let x = h.slice(1);
  if (x.length === 3 || x.length === 4) x = [...x.slice(0, 3)].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(x)) return null;
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)) as [number, number, number];
}

/** Whether the terminal takes 24-bit colour; otherwise the nearest of 256. */
export function trueColor(env: Record<string, string | undefined> = Deno.env.toObject()): boolean {
  return /truecolor|24bit/i.test(env.COLORTERM ?? "") || !!env.WT_SESSION ||
    /^(iTerm\.app|WezTerm|vscode|ghostty)$/.test(env.TERM_PROGRAM ?? "");
}

function rgb256(r: number, g: number, b: number): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const [lr, lg, lb] = [level(r), level(g), level(b)];
  const steps = [0, 95, 135, 175, 215, 255];
  const cube = 16 + 36 * lr + 6 * lg + lb;
  const dc = (steps[lr] - r) ** 2 + (steps[lg] - g) ** 2 + (steps[lb] - b) ** 2;
  const avg = (r + g + b) / 3;
  const gi = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + gi * 10;
  const dg = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return dg < dc ? 232 + gi : cube;
}

/** A colour as SGR parameters (foreground, or background with `bg`); "" for none. */
export function tuiColor(value: string, bg = false, tc = trueColor()): string | null {
  const v = value.trim().toLowerCase();
  if (NONE.has(v)) return "";
  if (v in ANSI_NAMES) return String(ANSI_NAMES[v][0] + (bg ? 10 : 0));
  let rgb: [number, number, number] | null = null;
  const hex = CSS_NAMES[v] ?? (v.startsWith("#") ? v : null);
  if (hex) rgb = hexRgb(hex);
  const fn = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (fn) rgb = [+fn[1], +fn[2], +fn[3]].map((n) => Math.min(255, n)) as typeof rgb;
  if (!rgb) return null;
  const lead = bg ? 48 : 38;
  return tc ? `${lead};2;${rgb.join(";")}` : `${lead};5;${rgb256(...rgb)}`;
}

/** The first colour in a value ("1px solid #333", "linear-gradient(red, blue)"). */
function firstColor(value: string, bg: boolean, tc: boolean): string | null {
  const whole = tuiColor(value, bg, tc);
  if (whole !== null) return whole;
  for (const m of value.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|[a-z][a-z-]*/gi)) {
    if (NONE.has(m[0].toLowerCase())) continue;
    const c = tuiColor(m[0], bg, tc);
    if (c) return c;
  }
  return null;
}

/** The colour in a border ("2px dashed #ff0" → "#ff0"), if any. */
function colorIn(value: string): string | undefined {
  return splitTop(value.trim(), " ").map((x) => x.trim()).find((x) =>
    x && !/^[\d.]/.test(x) && !BORDER_WORDS.has(x.toLowerCase())
  );
}

const BORDER_WORDS = new Set([
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
  "none",
  "hidden",
  "thin",
  "medium",
  "thick",
]);

// ---- the terminal ----

const ON = new Set(["on", "true", "yes", "1"]);

/** A role's declarations as SGR parameters ("1;36"), "" for plain. */
export function sgrOf(d: Decls | undefined, tc = trueColor()): string {
  if (!d) return "";
  const out: string[] = [];
  const weight = (d["font-weight"] ?? "").toLowerCase();
  if (weight === "bold" || weight === "bolder" || +weight >= 600) out.push("1");
  const faint = weight === "lighter" || (d.opacity !== undefined && +d.opacity < 1);
  if (faint) out.push("2");
  if (/italic|oblique/.test(d["font-style"] ?? "")) out.push("3");
  const deco = (d["text-decoration"] ?? d["text-decoration-line"] ?? "").toLowerCase();
  if (deco.includes("underline")) out.push("4");
  if (deco.includes("line-through")) out.push("9");
  if (ON.has((d.inverse ?? "").toLowerCase())) out.push("7");
  const fg = d.color ? firstColor(d.color, false, tc) : "";
  if (fg) out.push(fg);
  const bgv = d["background-color"] ?? d.background;
  const bg = bgv ? firstColor(bgv, true, tc) : "";
  if (bg) out.push(bg);
  return out.join(";");
}

/** A theme compiled for a terminal. */
export interface TuiTheme {
  name: string;
  /** SGR parameters for a role ("" when plain). */
  sgr(role: string): string;
  /** Text in a role's style. */
  paint(role: string, s: string): string;
  /** A role's `content` (the marks), or the fallback. */
  content(role: string, fallback: string): string;
  /** The SGR parameters every row sits on (the text role), "" for the terminal's own. */
  base: string;
  /** ANSI colours in lines (31-36) in the theme's red..cyan. */
  remap(s: string): string;
  /** A row with resets that return to the base, not the terminal's colours. */
  onBase(row: string): string;
}

const ESC = "\x1b[";
const SGR = new RegExp(String.fromCharCode(27) + "\\[([0-9;]*)m", "g");
const NAMED = ["red", "green", "yellow", "blue", "magenta", "cyan"];

export function compileTui(theme: Theme, all: Map<string, Theme>, tc = trueColor()): TuiTheme {
  const { rules, vars } = resolve(theme, "tui", all);
  const decls = (role: string): Decls | undefined => {
    const d = rules.get(role);
    if (!d) return undefined;
    return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, subst(v, vars)]));
  };
  const cache = new Map<string, string>();
  const sgr = (role: string) => {
    let s = cache.get(role);
    if (s === undefined) cache.set(role, s = sgrOf(decls(role), tc));
    return s;
  };
  // The bubble's frame takes its border colour; its pointer, the frame's.
  const b = decls("bubble") ?? {};
  const border = colorIn(b["border-color"] ?? b.border ?? "");
  cache.set("bubble.frame", border ? sgrOf({ ...b, color: border }, tc) : sgr("bubble"));
  if (!rules.has("bubble.tail")) {
    cache.set("bubble.tail", sgrOf({ color: border ?? b.color ?? "default" }, tc));
  }
  const base = sgr("text");
  const baseDecls = decls("text") ?? {};
  const baseFg = baseDecls.color ? firstColor(baseDecls.color, false, tc) || "39" : "39";
  const bgv = baseDecls["background-color"] ?? baseDecls.background;
  const baseBg = bgv ? firstColor(bgv, true, tc) || "49" : "49";
  const swaps = new Map<string, string>();
  NAMED.forEach((n, i) => {
    const s = sgr(n);
    if (s && s !== String(31 + i)) swaps.set(String(31 + i), s);
  });
  const mapParams = (params: string, f: (p: string) => string) => {
    const ps = (params || "0").split(";");
    const out: string[] = [];
    for (let i = 0; i < ps.length; i++) {
      // 38;5;n and 38;2;r;g;b carry their own numbers.
      if ((ps[i] === "38" || ps[i] === "48") && (ps[i + 1] === "5" || ps[i + 1] === "2")) {
        const n = ps[i + 1] === "5" ? 3 : 5;
        out.push(ps.slice(i, i + n).join(";"));
        i += n - 1;
      } else out.push(f(ps[i]));
    }
    return out.join(";");
  };
  return {
    name: theme.name,
    sgr,
    paint: (role, s) => {
      const p = sgr(role);
      return p && s ? `${ESC}${p}m${s}${ESC}0m` : s;
    },
    content: (role, fallback) => {
      const c = decls(role)?.content;
      return c && /^(["']).*\1$/.test(c.trim()) ? unquote(c) : fallback;
    },
    base,
    remap: (s) =>
      swaps.size ? s.replace(SGR, (_, p) => `${ESC}${mapParams(p, (x) => swaps.get(x) ?? x)}m`) : s,
    onBase: (row) =>
      base
        ? `${ESC}${base}m` +
          row.replace(
            SGR,
            (_, p) =>
              `${ESC}${
                mapParams(p, (x) => (x === "0" || x === ""
                  ? `0;${base}`
                  : x === "39"
                  ? baseFg
                  : x === "49"
                  ? baseBg
                  : x))
              }m`,
          )
        : row,
  };
}

// ---- the GUI ----

/** Properties only a terminal reads. */
const TUI_ONLY = new Set(["inverse"]);

function guiValue(v: string): string {
  // The terminal's colour names, as the GUI draws them.
  return v.replace(
    /(?<![\w#-])(bright-[a-z]+|grey|gray|black|red|green|yellow|blue|magenta|cyan|white)(?![\w-])/g,
    (n) => ANSI_NAMES[n]?.[1] ?? n,
  );
}

/** A theme as the GUI's stylesheet. */
export function compileGui(theme: Theme, all: Map<string, Theme>): string {
  const { rules, vars } = resolve(theme, "gui", all);
  const out: string[] = [];
  const declText = (d: Decls, rename: Record<string, string> = {}) => {
    const parts: string[] = [];
    for (const [k, raw] of Object.entries(d)) {
      if (TUI_ONLY.has(k) || k.startsWith("--")) continue;
      const v = subst(raw, vars).trim();
      // Nothing that could leave the rule or the style element.
      if (/[<>{}]/.test(v) || /(?<![\w-])default(?![\w-])/.test(v)) continue;
      const value = k === "font-family" || k === "content" ? v : guiValue(v);
      parts.push(`${rename[k] ?? k}: ${value};`);
    }
    return parts.join(" ");
  };
  for (const [role, d] of rules) {
    if (role === "rule") {
      const c = d["border-color"] ?? d.color;
      if (c) out.push(`${RULED} { ${declText({ "border-color": c })} }`);
      continue;
    }
    const sel = ROLES[role]?.gui;
    if (!sel) continue;
    const body = role === "bubble.tail"
      ? declText({ "border-right-color": d.color ?? d["border-color"] ?? "default" })
      : declText(d);
    if (body) out.push(`${sel} { ${body} }`);
  }
  // The bubble's pointer: its border colour unless set.
  if (!rules.has("bubble.tail")) {
    const b = rules.get("bubble") ?? {};
    const color = colorIn(subst(b["border-color"] ?? b.border ?? "", vars)) ??
      (b.color && subst(b.color, vars));
    if (color) out.push(`#speech::before { ${declText({ "border-right-color": color })} }`);
  }
  return out.join("\n");
}

// ---- the current theme ----

export const DEFAULT_THEME = "default";

let currentName = DEFAULT_THEME;
let current: Theme = parseTheme(DEFAULT_THEME, BUILT_IN[DEFAULT_THEME]);
let known: Map<string, Theme> = new Map([[DEFAULT_THEME, current]]);
let tui: TuiTheme = compileTui(current, known);
const listeners = new Set<() => void>();

export function themeName(): string {
  return currentName;
}

/** The current theme, for a terminal. */
export function tuiTheme(): TuiTheme {
  return tui;
}

/**
 * The current theme for the line interface, which cannot fill the screen:
 * a theme with a background of its own (dark ink on paper) would be
 * unreadable on the terminal's, so those give the default's colours there.
 */
export function lineTheme(): TuiTheme {
  if (!tui.base) return tui;
  const d = known.get(DEFAULT_THEME) ?? parseTheme(DEFAULT_THEME, BUILT_IN[DEFAULT_THEME]);
  return plainTui ??= compileTui(d, known);
}
let plainTui: TuiTheme | undefined;

/** The current theme, as the GUI's stylesheet. */
export function guiCss(): string {
  return compileGui(current, known);
}

/** Called after the theme changes. Returns the unsubscribe. */
export function onTheme(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function themePath(): string {
  return join(dataDir(), "theme.json");
}

/**
 * Switches to a theme by name (built in or the user's, read again now), and
 * keeps it unless `save` is false. Returns it, or null when there is no such
 * theme.
 */
export async function setTheme(name: string, save = true): Promise<Theme | null> {
  const all = await allThemes();
  const t = all.get(name.toLowerCase());
  if (!t) return null;
  known = all;
  plainTui = undefined;
  current = t;
  currentName = t.name;
  tui = compileTui(t, all);
  if (save) {
    await ensureDir(dataDir());
    await Deno.writeTextFile(themePath(), JSON.stringify({ name: t.name }) + "\n");
  }
  for (const f of listeners) {
    try {
      f();
    } catch {
      // a frontend's own problem
    }
  }
  return t;
}

/** The theme kept from last time (or AIBOOT_THEME), at start. */
export async function loadSavedTheme(): Promise<void> {
  let name = Deno.env.get("AIBOOT_THEME");
  if (!name) {
    try {
      name = JSON.parse(await Deno.readTextFile(themePath()))?.name;
    } catch {
      // none kept
    }
  }
  if (name && name !== DEFAULT_THEME) await setTheme(name, false);
}

/** /theme: the themes (no name), or a switch to one (kept for next time). */
export async function themeCommand(arg: string): Promise<string> {
  const want = arg.trim();
  if (want) {
    const t = await setTheme(want);
    if (!t) return `no theme "${want}"; /theme lists them`;
    const warned = t.warnings.length
      ? `\n  (in ${t.source}: ${t.warnings.slice(0, 5).join("; ")}${
        t.warnings.length > 5 ? "; ..." : ""
      })`
      : "";
    return `theme: ${t.name}${t.description ? ` (${t.description})` : ""}${warned}`;
  }
  const all = await allThemes();
  const width = Math.max(...[...all.keys()].map((n) => n.length));
  const rows = [...all.values()].map((t) =>
    `${t.name === currentName ? "*" : " "} ${t.name.padEnd(width)}  ${t.description}${
      t.source === "built in" ? "" : ` (${t.source})`
    }`
  );
  return `themes:\n${
    rows.join("\n")
  }\n/theme NAME switches (and keeps it). Your own: NAME.css in ${themesDir()}, e.g. starting with "@extends default;" (docs/themes.md).`;
}
