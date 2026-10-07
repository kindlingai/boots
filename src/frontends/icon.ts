// The GUI's icon: lil boots as pixel art (grey body, white eyes, blue boots,
// red antenna light) on a dark rounded tile. The page uses it as an SVG
// favicon; the native window gets it as a PNG (the macOS Dock), an ICO
// (Windows) or a themed icon (Linux, GTK). All of it best-effort: a window
// without its icon still works.

import { join } from "@std/path";

/** 16x16: g grey, w white, b blue, r red; anything else is the tile. */
const ART = [
  "................",
  "................",
  ".......rr.......",
  ".......rr.......",
  "................",
  "..gggggggggggg..",
  "..g..........g..",
  "..g..ww..ww..g..",
  "..g..ww..ww..g..",
  "..g..........g..",
  "..gggggggggggg..",
  ".....g....g.....",
  ".....g....g.....",
  "....bb....bb....",
  "....bb....bb....",
  "................",
];

const COLORS: Record<string, [number, number, number]> = {
  g: [0x8a, 0x8f, 0x98],
  w: [0xff, 0xff, 0xff],
  b: [0x4a, 0xa8, 0xff],
  r: [0xb8, 0x34, 0x3c],
};
const TILE: [number, number, number] = [0x12, 0x14, 0x17];

const hex = (c: [number, number, number]) =>
  "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("");

/** The icon as SVG (for the page's favicon). */
export function iconSvg(): string {
  const cells: string[] = [];
  ART.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const c = COLORS[ch];
      if (c) cells.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${hex(c)}"/>`);
    })
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" rx="3" fill="${
    hex(TILE)
  }"/>${cells.join("")}</svg>`;
}

/** The page's <link rel="icon"> href. */
export function faviconHref(): string {
  return `data:image/svg+xml,${encodeURIComponent(iconSvg())}`;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** The icon as a `size` x `size` PNG (RGBA; transparent outside the rounded tile). */
export async function iconPng(size = 256): Promise<Uint8Array> {
  const px = size / 16;
  const radius = size * 3 / 16;
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // Inside the rounded tile?
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const inside = dx * dx + dy * dy <= radius * radius;
      const ch = ART[Math.floor(y / px)][Math.floor(x / px)];
      const c = COLORS[ch] ?? TILE;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
      raw[o + 3] = inside ? 255 : 0;
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const h = new DataView(ihdr.buffer);
  h.setUint32(0, size);
  h.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

/** A Windows .ico holding the 256px PNG (Vista and later read PNG entries). */
export function icoFromPng(png: Uint8Array): Uint8Array {
  const ico = new Uint8Array(22 + png.length);
  const v = new DataView(ico.buffer);
  v.setUint16(2, 1, true); // type: icon
  v.setUint16(4, 1, true); // one image
  // width/height 0 = 256, no palette
  v.setUint16(10, 1, true); // planes
  v.setUint16(12, 32, true); // bits per pixel
  v.setUint32(14, png.length, true);
  v.setUint32(18, 22, true);
  ico.set(png, 22);
  return ico;
}

const cstr = (s: string) => new TextEncoder().encode(s + "\0");

/** macOS: the Dock icon of this process (NSApp setApplicationIconImage:). */
function macIcon(png: Uint8Array): void {
  const objc = Deno.dlopen("/usr/lib/libobjc.A.dylib", {
    objc_getClass: { parameters: ["buffer"], result: "pointer" },
    sel_registerName: { parameters: ["buffer"], result: "pointer" },
    send0: { name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "pointer" },
    send1: {
      name: "objc_msgSend",
      parameters: ["pointer", "pointer", "pointer"],
      result: "pointer",
    },
    sendBytes: {
      name: "objc_msgSend",
      parameters: ["pointer", "pointer", "buffer", "usize"],
      result: "pointer",
    },
  });
  const s = objc.symbols;
  const cls = (n: string) => s.objc_getClass(cstr(n));
  const sel = (n: string) => s.sel_registerName(cstr(n));
  const app = s.send0(cls("NSApplication"), sel("sharedApplication"));
  const data = s.sendBytes(cls("NSData"), sel("dataWithBytes:length:"), png, BigInt(png.length));
  const image = s.send1(s.send0(cls("NSImage"), sel("alloc")), sel("initWithData:"), data);
  if (app && image) s.send1(app, sel("setApplicationIconImage:"), image);
}

/** Windows: the window's big and small icons, from an .ico file. */
function windowsIcon(hwnd: Deno.PointerValue, icoPath: string): void {
  const u = Deno.dlopen("user32.dll", {
    LoadImageW: {
      parameters: ["pointer", "buffer", "u32", "i32", "i32", "u32"],
      result: "pointer",
    },
    SendMessageW: { parameters: ["pointer", "u32", "usize", "pointer"], result: "isize" },
  });
  const wide = new Uint16Array([...icoPath].map((c) => c.charCodeAt(0)).concat(0));
  const path = new Uint8Array(wide.buffer);
  const IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10, WM_SETICON = 0x80;
  const big = u.symbols.LoadImageW(null, path, IMAGE_ICON, 256, 256, LR_LOADFROMFILE);
  const small = u.symbols.LoadImageW(null, path, IMAGE_ICON, 32, 32, LR_LOADFROMFILE);
  if (big) u.symbols.SendMessageW(hwnd, WM_SETICON, 1n, big);
  if (small) u.symbols.SendMessageW(hwnd, WM_SETICON, 0n, small);
}

/** Linux: install the icon into the user's icon theme and name it on the window. */
function linuxIcon(window: Deno.PointerValue, pngPath: string, name: string): void {
  try {
    const gtk4 = Deno.dlopen("libgtk-4.so.1", {
      gtk_window_set_icon_name: { parameters: ["pointer", "buffer"], result: "void" },
    });
    gtk4.symbols.gtk_window_set_icon_name(window, cstr(name));
    return;
  } catch {
    // not GTK 4
  }
  const gtk3 = Deno.dlopen("libgtk-3.so.0", {
    gtk_window_set_icon_from_file: {
      parameters: ["pointer", "buffer", "pointer"],
      result: "i32",
    },
  });
  gtk3.symbols.gtk_window_set_icon_from_file(window, cstr(pngPath), null);
}

/**
 * Gives the native window (and on macOS the Dock) the icon. `window` is
 * the webview's native window handle. Never throws.
 */
export async function setWindowIcon(window: Deno.PointerValue): Promise<void> {
  try {
    const png = await iconPng(256);
    if (Deno.build.os === "darwin") return macIcon(png);
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
    if (Deno.build.os === "windows") {
      const dir = join(Deno.env.get("LOCALAPPDATA") ?? home, "ai-bootstrap");
      await Deno.mkdir(dir, { recursive: true });
      const path = join(dir, "boots.ico");
      await Deno.writeFile(path, icoFromPng(png));
      return windowsIcon(window, path);
    }
    const dir = join(
      Deno.env.get("XDG_DATA_HOME") ?? join(home, ".local", "share"),
      "icons",
      "hicolor",
      "256x256",
      "apps",
    );
    await Deno.mkdir(dir, { recursive: true });
    const path = join(dir, "ai-bootstrap.png");
    await Deno.writeFile(path, png);
    linuxIcon(window, path, "ai-bootstrap");
  } catch {
    // An icon is a nicety.
  }
}
