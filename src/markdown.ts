// Best-effort Markdown for the model's words: tables, lists, headings, quotes,
// code blocks, rules and inline **bold**, *italic*, `code` and [links](url).
// markdownLines draws it for a terminal (lines of a given width, in a base
// colour); markdownHtml for the GUI's page (shipped there with toString, so it
// uses no outside names). Anything it does not recognise stays as written.

const ESC = "\x1b[";

/** A visible character and the inline styles on it (b bold, i italic, c code, d dim, h heading). */
interface Cell {
  ch: string;
  s: string;
}

const BULLETS = ["•", "◦", "▪", "▫"];

/** Inline Markdown as styled cells. */
export function inlineCells(text: string, style = ""): Cell[] {
  const out: Cell[] = [];
  const push = (t: string, s: string) => {
    for (const ch of t.replace(/\t/g, "  ")) out.push({ ch, s });
  };
  // `code`, **bold**, __bold__, *italic*, _italic_, [text](url), ~~strike~~ (kept plain).
  const re =
    /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])|\[([^\]]+)\]\(([^)\s]+)\)|~~(.+?)~~/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    push(text.slice(at, m.index), style);
    if (m[1] !== undefined) push(m[1], style + "c");
    else if (m[2] !== undefined) out.push(...inlineCells(m[2], style + "b"));
    else if (m[3] !== undefined) out.push(...inlineCells(m[3], style + "b"));
    else if (m[4] !== undefined) out.push(...inlineCells(m[4], style + "i"));
    else if (m[5] !== undefined) out.push(...inlineCells(m[5], style + "i"));
    else if (m[6] !== undefined) {
      out.push(...inlineCells(m[6], style + "u"));
      if (m[7] !== m[6]) push(` (${m[7]})`, style + "d");
    } else if (m[8] !== undefined) out.push(...inlineCells(m[8], style));
    at = m.index! + m[0].length;
  }
  push(text.slice(at), style);
  return out;
}

/** Word-wraps cells to `w` columns (a word longer than a line is cut). */
function wrapCells(cells: Cell[], w: number): Cell[][] {
  w = Math.max(1, w);
  const out: Cell[][] = [];
  let rest = cells;
  while (rest.length > w) {
    let cut = rest.slice(0, w + 1).map((c) => c.ch).lastIndexOf(" ");
    if (cut <= w / 3) cut = w;
    let line = rest.slice(0, cut);
    while (line.length && line.at(-1)!.ch === " ") line = line.slice(0, -1);
    out.push(line);
    rest = rest.slice(cut);
    while (rest[0]?.ch === " ") rest = rest.slice(1);
  }
  out.push(rest);
  return out;
}

const cellsOf = (t: string, s = ""): Cell[] => [...t].map((ch) => ({ ch, s }));

/** SGR parameters for each inline style. */
const CODES: Record<string, string> = { b: "1", i: "3", c: "2", d: "2", u: "4", h: "1" };

/** Cells as a terminal line: each run in the base colour plus its styles. */
function draw(cells: Cell[], base: string): string {
  let s = "", cur: string | null = null;
  for (const c of cells) {
    const codes = [...new Set(c.s)].map((k) => CODES[k]).filter(Boolean);
    const sgr = [base, ...codes].filter(Boolean).join(";");
    if (sgr !== cur) {
      s += `${ESC}0${sgr ? `;${sgr}` : ""}m`;
      cur = sgr;
    }
    s += c.ch;
  }
  return cur !== null ? `${s}${ESC}0m` : s;
}

interface Table {
  head: string[];
  align: ("l" | "c" | "r")[];
  rows: string[][];
}

const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** The cells of a table row: split at | (not \| or inside `code`). */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "", code = false;
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      code = !code;
      cur += ch;
    } else if (ch === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** A table starting at line i (a row, then a separator row), and where it ends. */
function readTable(lines: string[], i: number): { table: Table; end: number } | null {
  if (!lines[i]?.includes("|") || !SEP.test(lines[i + 1] ?? "")) return null;
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "c" : c.endsWith(":") ? "r" : "l"
  ) as Table["align"];
  const rows: string[][] = [];
  let j = i + 2;
  while (j < lines.length && lines[j].includes("|") && lines[j].trim()) {
    rows.push(splitRow(lines[j]));
    j++;
  }
  return { table: { head, align, rows }, end: j };
}

/** A table in box lines, fitted to `width`; too many columns for it: one row per item. */
function tableLines(t: Table, width: number, base: string): string[] {
  const n = Math.max(t.head.length, ...t.rows.map((r) => r.length));
  const cell = (r: string[], k: number) => inlineCells(r[k] ?? "");
  const all = [t.head, ...t.rows];
  const widths = Array.from(
    { length: n },
    (_, k) => Math.max(1, ...all.map((r) => cell(r, k).length)),
  );
  const room = width - (3 * n + 1);
  const MIN = 3;
  if (room < MIN * n) {
    // As a list: each row's cells, named by their headers.
    const out: string[] = [];
    for (const r of t.rows) {
      const parts = Array.from({ length: n }, (_, k) => {
        const name = inlineCells(t.head[k] ?? "", "b");
        return [...name, ...cellsOf(": "), ...cell(r, k)];
      });
      const first = [
        ...cellsOf("• "),
        ...parts.flatMap((p, k) => k ? [...cellsOf("; "), ...p] : p),
      ];
      wrapCells(first, width - 2).forEach((l, k) =>
        out.push(draw(k ? [...cellsOf("  "), ...l] : l, base))
      );
    }
    return out;
  }
  while (widths.reduce((a, b) => a + b, 0) > room) {
    const k = widths.indexOf(Math.max(...widths));
    if (widths[k] <= MIN) break;
    widths[k]--;
  }
  const line = (l: string, m: string, r: string) =>
    draw(cellsOf(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r, "d"), base);
  const row = (r: string[], head: boolean) => {
    const wrapped = widths.map((w, k) => wrapCells(inlineCells(r[k] ?? "", head ? "b" : ""), w));
    const height = Math.max(...wrapped.map((c) => c.length));
    const out: string[] = [];
    for (let y = 0; y < height; y++) {
      let cs: Cell[] = cellsOf("│", "d");
      wrapped.forEach((c, k) => {
        const text = c[y] ?? [];
        const pad = widths[k] - text.length;
        const left = t.align[k] === "r" ? pad : t.align[k] === "c" ? Math.floor(pad / 2) : 0;
        cs = [
          ...cs,
          ...cellsOf(" ".repeat(left + 1)),
          ...text,
          ...cellsOf(" ".repeat(pad - left + 1)),
          ...cellsOf("│", "d"),
        ];
      });
      out.push(draw(cs, base));
    }
    return out;
  };
  return [
    line("┌", "┬", "┐"),
    ...row(t.head, true),
    line("├", "┼", "┤"),
    ...t.rows.flatMap((r) => row(r, false)),
    line("└", "┴", "┘"),
  ];
}

/**
 * Markdown as terminal lines at most `width` wide, in `base` (SGR parameters,
 * e.g. the theme's assistant colour), with styles for bold, code and so on.
 */
export function markdownLines(text: string, width: number, base = ""): string[] {
  width = Math.max(10, width);
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  const para = (
    cells: Cell[],
    first: Cell[] = [],
    rest: Cell[] = first.map(() => ({ ch: " ", s: "" })),
  ) => {
    wrapCells(cells, width - first.length).forEach((l, k) =>
      out.push(draw([...(k ? rest : first), ...l], base))
    );
  };
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s*(```|~~~)/);
    if (fence) {
      if (f && f[1] === fence) {
        fence = null;
        continue;
      }
      for (const l of wrapCells(cellsOf(line.replace(/\t/g, "  "), "c"), width - 2)) {
        out.push(draw([...cellsOf("  "), ...l], base));
      }
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const table = readTable(lines, i);
    if (table) {
      out.push(...tableLines(table.table, width, base));
      i = table.end - 1;
      continue;
    }
    if (!line.trim()) {
      out.push("");
      continue;
    }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      para(inlineCells(h[2], h[1].length <= 2 ? "hu" : "h"));
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(draw(cellsOf("─".repeat(width), "d"), base));
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (li) {
      const level = Math.min(3, Math.floor(li[1].replace(/\t/g, "  ").length / 2));
      let body = li[3];
      let mark = /\d/.test(li[2]) ? li[2] : BULLETS[level];
      const task = body.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        mark = task[1] === " " ? "☐" : "☑";
        body = task[2];
      }
      const lead = "  ".repeat(level);
      para(
        inlineCells(body),
        cellsOf(`${lead}${mark} `, "d").map((c) => ({ ...c, s: c.ch.trim() ? "d" : "" })),
        cellsOf(" ".repeat(lead.length + [...mark].length + 1)),
      );
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      para(inlineCells(q[1], "i"), cellsOf("│ ", "d"));
      continue;
    }
    para(inlineCells(line));
  }
  return out;
}

/**
 * Markdown as HTML for the GUI's page: escaped first, then tables, lists,
 * headings, quotes, code and inline styles. Shipped to the page with
 * toString: it uses no outside names.
 */
export function markdownHtml(text: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (t: string): string => {
    const parts: string[] = [];
    // Code spans first, kept as they are.
    const s = t.replace(/`([^`]+)`/g, (_m, c) => {
      parts.push("<code>" + esc(c) + "</code>");
      return "\uE000" + (parts.length - 1) + "\uE000";
    });
    return esc(s)
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a, b) => "<b>" + (a ?? b) + "</b>")
      .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?![\w*])/g, "$1<i>$2</i>")
      .replace(/(^|[^\w_])_(?!\s)([^_]+?)_(?![\w_])/g, "$1<i>$2</i>")
      .replace(/~~(.+?)~~/g, "<s>$1</s>")
      .replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        '<span class="link">$1</span> <span class="url">($2)</span>',
      )
      .replace(/\uE000(\d+)\uE000/g, (_m, k) => parts[Number(k)]);
  };
  const lines = text.replace(/\r/g, "").split("\n");
  const sep = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const cells = (l: string) => {
    const out: string[] = [];
    let cur = "", code = false;
    const t = l.trim().replace(/^\|/, "").replace(/\|$/, "");
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === "\\" && t[i + 1] === "|") {
        cur += "|";
        i++;
      } else if (ch === "`") {
        code = !code;
        cur += ch;
      } else if (ch === "|" && !code) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  let html = "";
  const lists: { tag: string; level: number }[] = [];
  const closeLists = (level = -1) => {
    while (lists.length && lists[lists.length - 1].level > level) {
      html += "</" + lists.pop()!.tag + ">";
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      closeLists();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      html += "<pre>" + esc(body.join("\n")) + "</pre>";
      continue;
    }
    if (line.includes("|") && sep.test(lines[i + 1] ?? "")) {
      closeLists();
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""
      );
      const td = (tag: string, c: string, k: number) =>
        "<" + tag + (align[k] ? ' style="text-align:' + align[k] + '"' : "") + ">" + inline(c) +
        "</" + tag + ">";
      html += "<table><thead><tr>" + cells(line).map((c, k) => td("th", c, k)).join("") +
        "</tr></thead><tbody>";
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        html += "<tr>" + cells(lines[i]).map((c, k) => td("td", c, k)).join("") + "</tr>";
        i++;
      }
      html += "</tbody></table>";
      i--;
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (li) {
      const level = Math.min(3, Math.floor(li[1].replace(/\t/g, "  ").length / 2));
      const tag = /\d/.test(li[2]) ? "ol" : "ul";
      closeLists(level);
      // A list of the other kind at this level: that one ends here.
      const top = lists[lists.length - 1];
      if (top && top.level === level && top.tag !== tag) html += "</" + lists.pop()!.tag + ">";
      if (!lists.length || lists[lists.length - 1].level < level) {
        const start = tag === "ol" && parseInt(li[2]) !== 1
          ? ' start="' + parseInt(li[2]) + '"'
          : "";
        html += "<" + tag + start + ">";
        lists.push({ tag, level });
      }
      const task = li[3].match(/^\[([ xX])\]\s+(.*)$/);
      html += "<li>" + (task ? (task[1] === " " ? "☐ " : "☑ ") + inline(task[2]) : inline(li[3])) +
        "</li>";
      continue;
    }
    closeLists();
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) html += '<div class="h h' + h[1].length + '">' + inline(h[2]) + "</div>";
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) html += "<hr>";
    else if (/^\s*>/.test(line)) {
      html += "<blockquote>" + inline(line.replace(/^\s*>\s?/, "")) + "</blockquote>";
    } else if (!line.trim()) html += '<div class="gap"></div>';
    else html += "<div>" + inline(line) + "</div>";
  }
  closeLists();
  return html;
}

/**
 * Markdown as plain text, for the speech bubble: emphasis and code marks
 * dropped, list items as bullets, table rows as cells with spaces between,
 * fences and separator rows gone. Shipped to the GUI's page with toString.
 */
export function markdownPlain(text: string): string {
  return text.replace(/\r/g, "").split("\n")
    .filter((l) =>
      !/^\s*(```|~~~)/.test(l) && !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)
    )
    .map((l) =>
      l.replace(/^(\s*)[-*+]\s+\[([ xX])\]\s+/, (_m, s, x) => s + (x === " " ? "☐ " : "☑ "))
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(
          /^\s*\|(.*)\|\s*$/,
          (_m, row) => row.split("|").map((c: string) => c.trim()).join("   "),
        )
        .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a, b) => a ?? b)
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    ).join("\n");
}
