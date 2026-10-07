// The GUI's page: the TUI's layout in HTML. The bot is drawn by the very
// functions the TUI uses (bot.ts, shipped with toString), coloured the same
// way: grey body, white eyes, bright blue boots, light blue sweat, and an
// antenna that is grey as a line and dark red when it signals.

import { bot, DROP, moodOf, sweat } from "./bot.ts";
import { tidy } from "../frontend.ts";
import { faviconHref } from "./icon.ts";

/**
 * A line with terminal colour codes as HTML: each run of text in a span
 * whose classes name its colours (a1 bold, a2 dim, a31-a36 colours). Shipped
 * to the page with toString, so it uses no outside names.
 */
export function ansiHtml(text: string): string {
  const escape = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const run = (t: string, on: string[]) =>
    !t
      ? ""
      : on.length
      ? '<span class="' + on.map((c) => "a" + c).join(" ") + '">' + escape(t) + "</span>"
      : escape(t);
  const [first, ...rest] = text.split(String.fromCharCode(27));
  let on: string[] = [];
  let out = run(first, on);
  for (const part of rest) {
    const m = part.match(/^\[([0-9;]*)([A-Za-z])/);
    if (!m) {
      out += run(part, on);
      continue;
    }
    if (m[2] === "m") {
      for (const c of (m[1] || "0").split(";")) {
        if (c === "0") on = [];
        else if (c === "22") on = on.filter((x) => x !== "1" && x !== "2");
        else if (c === "39") on = on.filter((x) => !x.startsWith("3"));
        else if (/^(1|2|3[1-6])$/.test(c)) {
          on = [...on.filter((x) => !(c.startsWith("3") && x.startsWith("3")) && x !== c), c];
        }
      }
    }
    out += run(part.slice(m[0].length), on);
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function page(title: string, token: string): string {
  // The shared functions, as the page's own (they use no outside names).
  const shared = [
    `const DROP = ${JSON.stringify(DROP)};`,
    sweat.toString(),
    bot.toString(),
    moodOf.toString(),
    ansiHtml.toString(),
    tidy.toString(),
  ].join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="${faviconHref()}">
<style>
  :root {
    --bg: #121417; --panel: #1a1d22; --line: #2a2f37; --text: #d8dde4; --dim: #8b94a1;
    --cyan: #5fd7e8; --warn: #e5c07b; --err: #ef6b73; --ok: #8fd19e; --user: #c6a0f6;
    --grey: #8a8f98; --white: #ffffff; --blue: #4aa8ff; --sweat: #8be9fd; --red: #b8343c;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace; }
  body { display: flex; flex-direction: column; }
  header { display: flex; gap: 12px; align-items: baseline; padding: 6px 12px;
    background: var(--panel); border-bottom: 1px solid var(--line); }
  header .name { color: var(--cyan); font-weight: bold; }
  header .where { margin-left: auto; color: var(--dim); white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; }
  #top { display: flex; gap: 14px; align-items: center; padding: 10px 12px;
    border-bottom: 1px solid var(--line); }
  #bot { margin: 0; line-height: 1.15; white-space: pre; font-size: 15px; }
  #bot .g { color: var(--grey); } #bot .w { color: var(--white); } #bot .b { color: var(--blue); }
  #bot .s { color: var(--sweat); } #bot .r { color: var(--red); }
  #bubble { flex: 1; position: relative; border: 1px solid var(--cyan); border-radius: 10px;
    padding: 8px 12px; color: var(--cyan); max-height: 6.2em; overflow: hidden;
    display: flex; flex-direction: column; justify-content: flex-end; white-space: pre-wrap; }
  #bubble::before { content: ""; position: absolute; left: -9px; top: 50%; margin-top: -8px;
    border: 8px solid transparent; border-right-color: var(--cyan); border-left: 0; }
  #log { flex: 1; overflow-y: auto; padding: 8px 12px; white-space: pre-wrap;
    overflow-wrap: anywhere; }
  #log div { min-height: 1.45em; }
  .dim, .info { color: var(--dim); } .warn { color: var(--warn); } .error { color: var(--err); }
  .ok { color: var(--ok); } .bold { font-weight: bold; } .user { color: var(--user); }
  .assistant { color: var(--text); } .assistant::before { content: "● "; color: var(--cyan); }
  .user::before { content: "› "; }
  #status { padding: 4px 12px; color: var(--dim); border-top: 1px solid var(--line);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.9em; }
  #status .spin { color: var(--cyan); }
  #goal { padding: 5px 12px; color: var(--warn); border-bottom: 1px solid var(--line);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #goal:empty { display: none; }
  #goal .step { color: var(--text); }
  #goal .more { color: var(--dim); }
  .a1 { font-weight: bold; } .a2 { opacity: .65; } .a31 { color: var(--err); }
  .a32 { color: var(--ok); } .a33 { color: var(--warn); } .a34 { color: var(--blue); }
  .a35 { color: #d38df0; } .a36 { color: var(--cyan); }
  form.asking #input { display: none; }
  #choices { display: inline-flex; gap: 8px; flex-wrap: wrap; }
  button.choice u { text-decoration: none; color: var(--warn); font-weight: bold; }
  form { display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: var(--panel);
    border-top: 1px solid var(--line); flex-wrap: wrap; }
  #prompt { color: var(--cyan); white-space: pre-wrap; max-width: 100%; }
  #input { flex: 1; min-width: 12em; background: var(--bg); color: var(--text);
    border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font: inherit; }
  #input:focus { outline: none; border-color: var(--cyan); }
  #input:disabled { opacity: .5; }
  button { background: #242931; color: var(--text); border: 1px solid var(--line); border-radius: 6px;
    padding: 5px 10px; font: inherit; cursor: pointer; }
  button:hover { border-color: var(--cyan); }
  button.choice { color: var(--cyan); }
  #stop { color: var(--warn); }
  #quit { color: var(--dim); }
  .bye { color: var(--dim); padding: 20px; }
</style>
</head>
<body>
<header><span class="name" id="name">lil boots</span><span id="title"></span><span class="where" id="where"></span></header>
<div id="goal"></div>
<div id="top"><pre id="bot"></pre><div id="bubble"></div></div>
<div id="log"></div>
<div id="status"></div>
<form id="form" autocomplete="off">
  <span id="prompt"></span>
  <span id="choices"></span>
  <input id="input" autocomplete="off" spellcheck="false" disabled>
  <button type="button" id="stop" title="Stop (Esc Esc)">Stop</button>
  <button type="button" id="quit" title="Quit ai-bootstrap">Quit</button>
</form>
<script>
${shared}

const TOKEN = ${JSON.stringify(token)};
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const $ = (id) => document.getElementById(id);
let state = null, frame = 0, blinkUntil = 0, ws = null, lastEsc = -1e9, history = [], hpos = -1;

/** The bot's rows as coloured HTML, like the TUI's paintBot. */
function paint(art) {
  const span = (c, s) => s ? '<span class="' + c + '">' + s.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</span>" : "";
  const edges = (row, mid) => {
    const tint = (ch) => ch === " " ? ch : span("s", ch);
    return tint(row[0]) + mid(row.slice(1, -1)) + tint(row[row.length - 1]);
  };
  const [antenna, top, face, mouth, legs, feet] = art;
  const a = face.indexOf("|"), z = face.lastIndexOf("|");
  return [
    span(antenna.trim() === "|" ? "g" : "r", antenna),
    edges(top, (m) => span("g", m)),
    edges(face, (m) => span("g", m.slice(0, a)) + span("w", m.slice(a, z - 1)) + span("g", m.slice(z - 1))),
    edges(mouth, (m) => span("g", m)),
    span("g", legs),
    span("b", feet),
  ].join("\\n");
}

function mood() {
  if (!state) return "idle";
  return moodOf({
    flash: state.flash, streaming: state.streaming, talkedAt: state.talkedAt,
    progress: state.progress.length > 0, busy: state.busy ? state.busy.label : null,
    prompt: state.prompt ? state.prompt.prompt : null,
  });
}

function drawBot() {
  $("bot").innerHTML = paint(bot(mood(), frame, Date.now() < blinkUntil));
  if (!state) return;
  const said = tidy(state.busy && !state.streaming
    ? (state.activity || state.busy.label + "...")
    : (state.speech || "")) || "...";
  if ($("bubble").textContent !== said) $("bubble").textContent = said;
  const spin = '<span class="spin">' + FRAMES[frame % FRAMES.length] + "</span> ";
  const p = state.progress[state.progress.length - 1];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let status = "";
  if (p) status = spin + esc(p.label + "  " + p.text);
  else if (state.busy) {
    const s = Math.floor((Date.now() - state.busy.t0) / 1000);
    status = spin + esc(state.busy.label + "..." + (s >= 3 ? " " + s + "s" : "") +
      (state.busy.note ? " · " + state.busy.note : ""));
  } else status = "Enter to send · Esc Esc or Stop to interrupt · ↑↓ history";
  $("status").innerHTML = status;
}

function addEntry(kind, text) {
  const log = $("log");
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const d = document.createElement("div");
  d.className = kind;
  // Colour codes become spans; the user's and the assistant's words stay text.
  if (kind === "user" || kind === "assistant") d.textContent = text;
  else d.innerHTML = ansiHtml(text);
  log.appendChild(d);
  while (log.childElementCount > 2000) log.firstChild.remove();
  if (atEnd) log.scrollTop = log.scrollHeight;
}

function applyState(s) {
  const before = state && state.prompt ? state.prompt.id : null;
  state = s;
  $("name").textContent = s.name;
  $("where").textContent = [s.status.model, s.status.location].filter(Boolean).join("  ·  ");
  // The current goal and its active step, at the top.
  const goals = (s.goals || []).map(tidy).filter(Boolean);
  const gl = $("goal");
  gl.innerHTML = goals.length
    ? "◆ " + ansiHtml(goals[0]) + (goals[1] ? ' <span class="step">› ' + ansiHtml(goals[1]) + "</span>" : "") +
      (goals.length > 2 ? ' <span class="more">(+' + (goals.length - 2) + " more)</span>" : "")
    : "";
  const input = $("input");
  const pr = s.prompt;
  const asking = !!(pr && pr.choices && pr.choices.length);
  $("form").classList.toggle("asking", asking);
  // With choices, the question alone ("run it?"); the buttons say the rest.
  $("prompt").textContent = !pr ? "" : asking ? pr.prompt.replace(/\\[.*$/, "").trim() : pr.prompt.trim();
  // Always open: without a question, what is typed steers the model while it works.
  input.disabled = false;
  input.placeholder = pr ? "" : (s.busy || s.streaming ? "type to steer the model; Enter sends it" : "");
  input.type = pr && pr.hidden ? "password" : "text";
  if ((pr ? pr.id : null) !== before) {
    // A question (y/n, a password) sets a steering draft aside and gives it
    // back when it closes; a free-text prompt keeps it, after what a stop
    // handed back.
    const question = pr && (pr.hidden || (pr.choices && pr.choices.length));
    if (question) {
      if (input.value) draft = input.value;
      input.value = "";
    } else if (pr) {
      input.value = [pr.prefill || "", input.value || draft].filter(Boolean).join(" ");
      draft = "";
    } else {
      input.value = draft;
      draft = "";
    }
    hpos = -1;
    // [y]es [n]o ...: one button per choice.
    const box = $("choices");
    box.textContent = "";
    if (pr) {
      const add = (label, send) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.textContent = label;
        b.onclick = () => answer(send);
        box.appendChild(b);
      };
      if (asking) {
        // The full answers as buttons, in place of the input box; the key
        // letter is marked and works as a shortcut.
        for (const c of pr.choices) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "choice";
          const i = c.label.toLowerCase().indexOf(c.key.toLowerCase());
          const e = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
          b.innerHTML = i < 0
            ? e(c.label)
            : e(c.label.slice(0, i)) + "<u>" + e(c.label.slice(i, i + 1)) + "</u>" + e(c.label.slice(i + 1));
          b.title = "key: " + c.key;
          b.onclick = () => answer(c.key);
          box.appendChild(b);
        }
        box.firstChild.focus();
      } else {
        for (const m of pr.prompt.matchAll(/\\[(\\w)\\]([\\w-]*)/g)) add(m[1] + m[2], m[1]);
        if (/\\[[Yy]\\/[Nn]\\]/.test(pr.prompt)) { add("yes", "y"); add("no", "n"); }
        input.focus();
      }
    }
  }
}

/** Messages wait for the socket while it (re)connects, instead of being lost. */
let outbox = [];
function send(m) {
  outbox.push(JSON.stringify(m));
  flush();
}
function flush() {
  while (ws && ws.readyState === WebSocket.OPEN && outbox.length) ws.send(outbox.shift());
}

let draft = "";

function answer(text) {
  if (!state) return;
  if (!state.prompt) {
    // Nothing asked: a message for the model, read after its current step.
    if (!text.trim()) return;
    if (history[history.length - 1] !== text) history.push(text);
    send({ t: "steer", text });
    $("input").value = "";
    return;
  }
  if (!state.prompt.hidden && text.trim() && history[history.length - 1] !== text) history.push(text);
  send({ t: "answer", id: state.prompt.id, text });
}

function stop() { send({ t: "stop" }); }

function connect() {
  ws = new WebSocket("ws://" + location.host + "/ws?t=" + encodeURIComponent(TOKEN));
  ws.onopen = flush;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "init") {
      document.title = m.title;
      $("title").textContent = m.title;
      $("log").textContent = "";
      for (const e of m.entries) addEntry(e.kind, e.text);
      state = null;
      applyState(m.state);
    } else if (m.t === "entry") addEntry(m.kind, m.text);
    else if (m.t === "stream") {
      const last = $("log").lastElementChild;
      if (last && last.className === "assistant") {
        const log = $("log");
        const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        last.textContent = m.text;
        if (atEnd) log.scrollTop = log.scrollHeight;
      }
      if (state) { state.speech = m.text; state.streaming = true; state.talkedAt = Date.now(); }
    } else if (m.t === "state") applyState(m.state);
    else if (m.t === "bye") {
      document.body.innerHTML = '<div class="bye">ai-bootstrap has finished. You can close this window.</div>';
      ws.onclose = null;
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}

$("form").onsubmit = (e) => { e.preventDefault(); answer($("input").value); };
$("stop").onclick = stop;
$("quit").onclick = () => {
  $("quit").disabled = true;
  $("quit").textContent = "Quitting…";
  send({ t: "quit" });
};
// The native macOS window has no Edit menu, so ⌘V/⌘C/⌘X/⌘A never arrive by
// themselves: when the window offers its clipboard (window.__aibPaste), do them here.
async function editKey(e) {
  if (!e.metaKey || e.ctrlKey || e.altKey || typeof window.__aibPaste !== "function") return false;
  const k = e.key.toLowerCase();
  if (!["v", "c", "x", "a"].includes(k)) return false;
  e.preventDefault();
  const el = document.activeElement;
  const field = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !el.disabled ? el : null;
  const picked = field
    ? field.value.slice(field.selectionStart, field.selectionEnd)
    : String(getSelection());
  if (k === "a") {
    if (field) field.select();
    else getSelection().selectAllChildren($("log"));
  } else if (k === "c" || k === "x") {
    if (picked) await window.__aibCopy(picked);
    if (k === "x" && field && picked) {
      field.setRangeText("", field.selectionStart, field.selectionEnd, "end");
      field.dispatchEvent(new Event("input"));
    }
  } else if (k === "v") {
    const text = await window.__aibPaste();
    const into = field || ($("input").disabled ? null : $("input"));
    if (into && text) {
      into.focus();
      // A one-line input: newlines become spaces.
      into.setRangeText(String(text).replace(/\\r?\\n/g, " "), into.selectionStart, into.selectionEnd, "end");
      into.dispatchEvent(new Event("input"));
    }
  }
  return true;
}
document.addEventListener("keydown", (e) => {
  // A choice's key answers it while the buttons are up.
  const pr = state && state.prompt;
  if (pr && pr.choices && pr.choices.length && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const c = pr.choices.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
    if (c) { e.preventDefault(); answer(c.key); return; }
  }
  if (e.metaKey && typeof window.__aibPaste === "function" && /^[vcxa]$/i.test(e.key)) {
    editKey(e);
    return;
  }
  if (e.key === "Escape") {
    const now = Date.now();
    if (now - lastEsc <= 2000) { lastEsc = -1e9; stop(); } else lastEsc = now;
  } else if (e.key === "c" && e.ctrlKey && !String(getSelection())) {
    e.preventDefault();
    stop();
  } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && document.activeElement === $("input")) {
    if (!history.length) return;
    e.preventDefault();
    if (e.key === "ArrowUp") hpos = hpos < 0 ? history.length - 1 : Math.max(0, hpos - 1);
    else hpos = hpos < 0 ? -1 : hpos + 1 >= history.length ? -1 : hpos + 1;
    $("input").value = hpos < 0 ? "" : history[hpos];
  }
});
setInterval(() => {
  frame++;
  if (Math.random() < 0.04) blinkUntil = Date.now() + 180;
  drawBot();
}, 160);
connect();
drawBot();
</script>
</body>
</html>`;
}
