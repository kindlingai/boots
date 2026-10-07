// The GUI's page: the TUI's layout in HTML. The bot is drawn by the very
// functions the TUI uses (bot.ts, shipped with toString), coloured the same
// way: grey body, white eyes, bright blue boots, light blue sweat, and an
// antenna that is grey as a line and dark red when it signals.

import { bot, DROP, moodOf, sweat } from "./bot.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function page(title: string, token: string): string {
  // The shared functions, as the page's own (they use no outside names).
  const shared = [
    `const DROP = ${JSON.stringify(DROP)};`,
    sweat.toString(),
    bot.toString(),
    moodOf.toString(),
  ].join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
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
  #status .goal { padding-left: 1.4em; }
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
  const said = state.busy && !state.streaming
    ? (state.activity || state.busy.label + "...")
    : (state.speech || "...");
  if ($("bubble").textContent !== said) $("bubble").textContent = said;
  const spin = '<span class="spin">' + FRAMES[frame % FRAMES.length] + "</span> ";
  const p = state.progress[state.progress.length - 1];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let status = "";
  if (p) status = spin + esc(p.label + "  " + p.text);
  else if (state.busy) {
    const s = Math.floor((Date.now() - state.busy.t0) / 1000);
    status = spin + esc(state.busy.label + "..." + (s >= 3 ? " " + s + "s" : ""));
  } else status = "Enter to send · Esc Esc or Stop to interrupt · ↑↓ history";
  const goals = state.goals || [];
  const more = goals.length - 2;
  for (const [i, t] of goals.slice(0, 2).entries()) {
    status += '<div class="goal">◆ ' + esc(t) + (i === 1 && more > 0 ? " (+" + more + " more)" : "") +
      "</div>";
  }
  $("status").innerHTML = status;
}

function addEntry(kind, text) {
  const log = $("log");
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const d = document.createElement("div");
  d.className = kind;
  d.textContent = text;
  log.appendChild(d);
  while (log.childElementCount > 2000) log.firstChild.remove();
  if (atEnd) log.scrollTop = log.scrollHeight;
}

function applyState(s) {
  const before = state && state.prompt ? state.prompt.id : null;
  state = s;
  $("name").textContent = s.name;
  $("where").textContent = [s.status.model, s.status.location].filter(Boolean).join("  ·  ");
  const input = $("input");
  const pr = s.prompt;
  $("prompt").textContent = pr ? pr.prompt.trim() : "";
  input.disabled = !pr;
  input.type = pr && pr.hidden ? "password" : "text";
  if ((pr ? pr.id : null) !== before) {
    input.value = "";
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
      for (const m of pr.prompt.matchAll(/\\[(\\w)\\]([\\w-]*)/g)) add(m[1] + m[2], m[1]);
      if (/\\[[Yy]\\/[Nn]\\]/.test(pr.prompt)) { add("yes", "y"); add("no", "n"); }
      input.focus();
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

function answer(text) {
  if (!state || !state.prompt) return;
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
document.addEventListener("keydown", (e) => {
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
