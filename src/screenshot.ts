// /screenshot: the GUI window as a PNG, drawn by the page itself (gui.ts).

import { dirname, resolve } from "@std/path";
import { frontend } from "./frontend.ts";
import { ensureDir, home } from "./platform.ts";

/** A PNG's size, from its header. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return null;
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** boots-20261008-142501.png */
export function shotName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `boots-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${
    p(d.getMinutes())
  }${p(d.getSeconds())}.png`;
}

/** Takes the screenshot and saves it (to `arg`, or a dated name here); says where. */
export async function screenshotCommand(arg: string): Promise<string> {
  const f = frontend();
  if (!f.screenshot) {
    return "/screenshot takes a picture of the GUI window: start ai-bootstrap with --gui";
  }
  const png = await f.screenshot();
  let path = arg.trim() || shotName();
  if (path === "~" || path.startsWith("~/")) path = home() + path.slice(1);
  if (!path.toLowerCase().endsWith(".png")) path += ".png";
  path = resolve(path);
  await ensureDir(dirname(path));
  await Deno.writeFile(path, png);
  const size = pngSize(png);
  return `saved a screenshot: ${path}${size ? ` (${size.width}×${size.height})` : ""}`;
}
