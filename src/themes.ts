// The built-in themes (theme.ts reads them; docs/themes.md has the syntax).
// "default" is how ai-bootstrap has always looked, and every other theme
// starts from it (@extends default): most change only its custom properties.
// A theme of the user's, <data dir>/themes/NAME.css, can do the same.

const DEFAULT = `
/* lil boots, as it has always looked. */
@description "the original: a grey bot in bright blue boots, speaking cyan";

:root {
  --text: default;        /* default: the terminal's own */
  --bg: default;
  --faint: default;
  --dimming: .65;         /* below 1: the terminal's dim, for quiet lines */
  --accent: cyan;
  --warn: yellow;
  --error: red;
  --ok: green;
  --user: default;
  --blue: blue;
  --magenta: magenta;
  --body: grey;
  --eyes: bright-white;
  --boots: bright-blue;
  --sweat: bright-cyan;
  --signal: red;
  --header-fg: default;
  --header-bg: default;
  --header-inverse: on;
}

text { color: var(--text); background: var(--bg); }
goal { color: var(--warn); }
bubble { color: var(--accent); }
bot.body { color: var(--body); }
bot.eyes { color: var(--eyes); }
bot.boots { color: var(--boots); }
bot.sweat { color: var(--sweat); }
bot.signal { color: var(--signal); }
assistant.mark { color: var(--accent); content: "● "; }
user.mark { content: "› "; }
warn { color: var(--warn); }
error { color: var(--error); }
ok { color: var(--ok); }
bold { font-weight: bold; }
red { color: var(--error); }
green { color: var(--ok); }
yellow { color: var(--warn); }
blue { color: var(--blue); }
magenta { color: var(--magenta); }
cyan { color: var(--accent); }
spinner { color: var(--accent); }

@media tui {
  header { color: var(--header-fg); background: var(--header-bg); inverse: var(--header-inverse); }
  rule, dim, info, status { color: var(--faint); opacity: var(--dimming); }
  user { color: var(--user); font-weight: bold; }
  assistant { color: var(--accent); }
  prompt { font-weight: bold; }
}

@media gui {
  :root {
    --text: #d8dde4;
    --bg: #121417;
    --panel: #1a1d22;
    --line: #2a2f37;
    --faint: #8b94a1;
    --accent: #5fd7e8;
    --warn: #e5c07b;
    --error: #ef6b73;
    --ok: #8fd19e;
    --user: #c6a0f6;
    --blue: #4aa8ff;
    --magenta: #d38df0;
    --button: #242931;
    --body: #8a8f98;
    --eyes: #ffffff;
    --boots: #4aa8ff;
    --sweat: #8be9fd;
    --signal: #b8343c;
    --font: ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace;
    --radius: 6px;
  }
  text { font-family: var(--font); font-size: 14px; line-height: 1.45; }
  panel { background: var(--panel); }
  rule { color: var(--line); }
  header.name { color: var(--accent); font-weight: bold; }
  header.where, goal.more, dim, info, status, quit { color: var(--faint); }
  goal.step { color: var(--text); }
  bubble { border: 1px solid var(--accent); border-radius: 10px; }
  user { color: var(--user); }
  assistant { color: var(--text); }
  prompt, choice { color: var(--accent); }
  input {
    background: var(--bg); color: var(--text);
    border: 1px solid var(--line); border-radius: var(--radius);
  }
  input.focus, button.hover { border-color: var(--accent); }
  button {
    background: var(--button); color: var(--text);
    border: 1px solid var(--line); border-radius: var(--radius);
  }
  choice.key { color: var(--warn); font-weight: bold; }
  stop { color: var(--warn); }
}
`;

const SOLARIZED = `
/* Solarized dark (Ethan Schoonover's palette). In a terminal it fills the screen. */
@extends default;
@description "Solarized dark: calm blues and greens on deep teal";

:root {
  --text: #93a1a1; --bg: #002b36; --panel: #073642; --line: #0f4552; --faint: #657b83;
  --dimming: 1;
  --accent: #2aa198; --warn: #b58900; --error: #dc322f; --ok: #859900; --user: #6c71c4;
  --blue: #268bd2; --magenta: #d33682; --button: #073642;
  --body: #839496; --eyes: #fdf6e3; --boots: #268bd2; --sweat: #2aa198; --signal: #cb4b16;
  --header-fg: #eee8d5; --header-bg: #073642; --header-inverse: off;
}
`;

const PHOSPHOR = `
/* A green-screen terminal from 1982, still warm. */
@extends default;
@description "green phosphor on black: one colour, a soft glow and scan lines";

:root {
  --text: #33ff66; --bg: #020a04; --panel: #04140a; --line: #0d4020; --faint: #1fa648;
  --dimming: 1;
  --accent: #8dffaa; --warn: #c6ff5c; --error: #eaffd0; --ok: #33ff66; --user: #b8ffc9;
  --blue: #5cffb0; --magenta: #8dffd2; --button: #04140a;
  --body: #1fa648; --eyes: #d9ffe3; --boots: #33ff66; --sweat: #8dffaa; --signal: #eaffd0;
  --header-fg: #020a04; --header-bg: #33ff66; --header-inverse: off;
  --glow: 51, 255, 102;
}
error { font-weight: bold; text-decoration: underline; }
assistant.mark { content: "> "; }
user.mark { content: "$ "; }

@media gui {
  :root { --font: "VT323", "IBM Plex Mono", "Courier New", Courier, monospace; --radius: 0; }
  text {
    /* VT323 is small for its size; this evens out whichever font is found. */
    font-size: 15px; font-size-adjust: .55;
    text-shadow: 0 0 2px rgba(var(--glow), .7), 0 0 10px rgba(var(--glow), .25);
    background: radial-gradient(ellipse at 50% 40%, #06260f 0%, var(--bg) 80%);
  }
  log {
    background-image: repeating-linear-gradient(
      to bottom, transparent 0, transparent 2px, rgba(0, 0, 0, .28) 3px, transparent 4px);
  }
  header { background: var(--text); color: var(--bg); text-shadow: none; }
  header.name, header.where { color: var(--bg); }
  bubble { border: 1px dashed var(--accent); border-radius: 0; }
  input { background: #010603; caret-color: var(--text); }
  bot { font-size: 16px; }
}
`;

const AMBER = `
/* The other screen in the lab: amber, from the same year. */
@extends phosphor;
@description "phosphor's twin, the colour of old IBM screens";

:root {
  --text: #ffb000; --bg: #0c0700; --panel: #160d00; --line: #4a3000; --faint: #b07a00;
  --accent: #ffd27a; --warn: #fff0a8; --error: #fff6e0; --ok: #ffb000; --user: #ffe0a0;
  --blue: #ffc94d; --magenta: #ffdf80; --button: #160d00;
  --body: #b07a00; --eyes: #fff3d6; --boots: #ffb000; --sweat: #ffd27a; --signal: #fff6e0;
  --header-fg: #0c0700; --header-bg: #ffb000;
  --glow: 255, 176, 0;
}
@media gui {
  text { background: radial-gradient(ellipse at 50% 40%, #261600 0%, var(--bg) 80%); }
}
`;

const SYNTHWAVE = `
/* Outrun: a purple dusk, neon on the horizon. */
@extends default;
@description "neon pink and cyan over a purple dusk";

:root {
  --text: #f4e9ff; --bg: #1b0f33; --panel: #241046; --line: #4b2a7a; --faint: #a58fd0;
  --dimming: 1;
  --accent: #ff4fd8; --warn: #ffd319; --error: #ff3864; --ok: #3cf2c4; --user: #36e2ff;
  --blue: #36e2ff; --magenta: #ff4fd8; --button: #2d1857;
  --body: #b39ddb; --eyes: #36e2ff; --boots: #ff4fd8; --sweat: #36e2ff; --signal: #ffd319;
  --header-fg: #1b0f33; --header-bg: #ff4fd8; --header-inverse: off;
}
assistant.mark { content: "▶ "; }
header { font-weight: bold; }

@media gui {
  text { background: linear-gradient(180deg, #1b0f33 0%, #2b1055 60%, #6b1d5c 100%); }
  panel { background: rgba(36, 16, 70, .85); }
  header.name {
    font-style: italic; letter-spacing: .12em; text-transform: uppercase;
    text-shadow: 0 0 8px var(--accent), 0 0 2px #fff;
  }
  bubble {
    border: 2px solid var(--accent); border-radius: 14px; background: rgba(27, 15, 51, .55);
    box-shadow: 0 0 14px rgba(255, 79, 216, .6), inset 0 0 12px rgba(255, 79, 216, .25);
    text-shadow: 0 0 6px rgba(255, 79, 216, .7);
  }
  bot.eyes, bot.boots, bot.signal { text-shadow: 0 0 6px currentColor; }
  input.focus { box-shadow: 0 0 8px rgba(54, 226, 255, .6); border-color: var(--user); }
  button.hover { box-shadow: 0 0 8px var(--accent); }
  goal { text-shadow: 0 0 6px rgba(255, 211, 25, .5); }
}
`;

const PAPER = `
/* Ink on warm paper, for daylight (and light terminals). */
@extends default;
@description "ink on warm paper, for daylight; a serif voice in the GUI";

:root {
  --text: #2b2a26; --bg: #fbf7ee; --panel: #f2ebdc; --line: #ddd3bf; --faint: #8c8576;
  --dimming: 1;
  --accent: #1d5f99; --warn: #a35d00; --error: #b3261e; --ok: #2e7d32; --user: #6b3fa0;
  --blue: #1d5f99; --magenta: #8e3b8e; --button: #efe7d6;
  --body: #6d6a63; --eyes: #2b2a26; --boots: #b3261e; --sweat: #1d5f99; --signal: #b3261e;
  --header-fg: #2b2a26; --header-bg: #e9e0cc; --header-inverse: off;
}
@media tui {
  assistant { color: var(--text); }
}
@media gui {
  :root { --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; }
  header.name { font-family: var(--serif); font-size: 16px; font-variant: small-caps; }
  bubble {
    color: var(--text); background: #ffffff; font-family: var(--serif); font-size: 15px;
    border: 1px solid var(--line); border-radius: 3px; box-shadow: 0 2px 8px rgba(60, 40, 10, .14);
  }
  assistant { font-family: var(--serif); font-size: 15px; }
  input { background: #fffdf8; }
}
`;

const COMIC = `
/* A Sunday comic strip. Yes, Comic Sans. */
@extends default;
@description "a big speech balloon, halftone dots, and Comic Sans, proudly";

:root {
  --text: #161616; --bg: #fff8dc; --panel: #ffe14d; --line: #161616; --faint: #6b6250;
  --dimming: 1;
  --accent: #e2231a; --warn: #c25e00; --error: #e2231a; --ok: #1f8a3a; --user: #1c4fd8;
  --blue: #1c4fd8; --magenta: #b0249c; --button: #ffffff;
  --body: #161616; --eyes: #1c4fd8; --boots: #e2231a; --sweat: #1c4fd8; --signal: #e2231a;
  --header-fg: #161616; --header-bg: #ffe14d; --header-inverse: off;
}
bubble { color: var(--text); background: #ffffff; border-color: var(--text); }
assistant { color: var(--text); }
assistant.mark { content: "💬 "; }
header { font-weight: bold; }

@media gui {
  :root { --font: "Comic Sans MS", "Comic Neue", "Chalkboard SE", "Comic Relief", cursive; }
  text {
    background: radial-gradient(circle, rgba(0, 0, 0, .1) 1px, transparent 1.6px) 0 0 / 9px 9px,
      var(--bg);
  }
  header.name { color: var(--accent); font-size: 18px; text-shadow: 1px 1px 0 #161616; }
  bubble {
    border: 3px solid #161616; border-radius: 28px; box-shadow: 4px 4px 0 #161616;
    font-size: 16px; font-weight: bold;
  }
  input { border: 2px solid #161616; border-radius: 12px; background: #ffffff; }
  button { border: 2px solid #161616; border-radius: 12px; box-shadow: 2px 2px 0 #161616; }
  button.hover { border-color: var(--accent); }
  choice.key { color: var(--accent); }
  goal { font-weight: bold; }
}
`;

const MONO = `
/* No colour at all, for terminals without it or eyes that prefer it. */
@extends default;
@description "no colour; bold, italic, underline and dim do the work";

:root {
  --accent: default; --warn: default; --error: default; --ok: default; --user: default;
  --blue: default; --magenta: default;
  --body: default; --eyes: default; --boots: default; --sweat: default; --signal: default;
}
warn, goal, spinner { font-weight: bold; }
error { font-weight: bold; text-decoration: underline; }
bubble { font-style: italic; }
bot.eyes, bot.boots { font-weight: bold; }

@media gui {
  :root {
    --text: #e4e4e4; --bg: #111111; --panel: #1a1a1a; --line: #333333; --faint: #8a8a8a;
    --accent: #e4e4e4; --warn: #ffffff; --error: #ffffff; --ok: #e4e4e4; --user: #ffffff;
    --blue: #cccccc; --magenta: #cccccc; --button: #222222;
    --body: #8a8a8a; --eyes: #ffffff; --boots: #ffffff; --sweat: #aaaaaa; --signal: #ffffff;
  }
}
`;

export const BUILT_IN: Record<string, string> = {
  default: DEFAULT,
  solarized: SOLARIZED,
  phosphor: PHOSPHOR,
  amber: AMBER,
  synthwave: SYNTHWAVE,
  paper: PAPER,
  comic: COMIC,
  mono: MONO,
};
