// The GUI's icon: a valid PNG, an ICO around it, an SVG favicon on the page.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { faviconHref, icoFromPng, iconPng, iconSvg, setWindowIcon } from "../src/frontends/icon.ts";
import { page } from "../src/frontends/gui_page.ts";

Deno.test("the icon: PNG, ICO and SVG favicon", async () => {
  const png = await iconPng(256);
  assertEquals([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(png.buffer, png.byteOffset);
  assertEquals(new TextDecoder().decode(png.subarray(12, 16)), "IHDR");
  assertEquals([v.getUint32(16), v.getUint32(20)], [256, 256]);
  const ico = icoFromPng(png);
  const iv = new DataView(ico.buffer);
  assertEquals([iv.getUint16(2, true), iv.getUint16(4, true), iv.getUint32(18, true)], [1, 1, 22]);
  assertEquals(ico.length, png.length + 22);
  assertStringIncludes(iconSvg(), "#4aa8ff", "blue boots");
  assertStringIncludes(
    page("t", "tok"),
    `<link rel="icon" type="image/svg+xml" href="${faviconHref()}">`,
  );
  // No window (and no GTK on the test machine): it never throws. Not on
  // macOS/Windows CI, where it would really set this process's icon.
  if (Deno.build.os === "linux") await setWindowIcon(null);
  assert(true);
});
