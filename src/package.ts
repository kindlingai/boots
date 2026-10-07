// Release packages (made by scripts/package.sh): the name of the package for
// each target, and how to get the ai-bootstrap binary back out of one.

import { VERSION } from "./platform.ts";

/**
 * The release asset holding the ai-bootstrap binary for `target`, e.g.
 * ai-bootstrap-0.1.21-x86_64-unknown-linux-gnu.tar.gz. The binary inside is
 * plain ai-bootstrap (ai-bootstrap.exe on Windows).
 */
export function packageName(target: string, version: string = VERSION): string {
  const ext = target.includes("windows") ? "zip" : target.includes("darwin") ? "sh" : "tar.gz";
  return `ai-bootstrap-${version.replace(/^v/, "")}-${target}.${ext}`;
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

const MARKER = new TextEncoder().encode("\n__PAYLOAD__\n");

function indexOf(hay: Uint8Array, needle: Uint8Array, limit = hay.length): number {
  outer: for (let i = 0; i + needle.length <= Math.min(hay.length, limit); i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** The gzipped binary after the __PAYLOAD__ line of a self-extracting script. */
async function fromScript(data: Uint8Array): Promise<Uint8Array> {
  const at = indexOf(data, MARKER, 4096);
  if (at < 0) throw new Error("not an ai-bootstrap script: no __PAYLOAD__ line");
  return await gunzip(data.subarray(at + MARKER.length));
}

/** The first regular file named ai-bootstrap in a gzipped tar. */
async function fromTarGz(data: Uint8Array): Promise<Uint8Array> {
  const tar = await gunzip(data);
  const d = new TextDecoder();
  const field = (h: Uint8Array, at: number, len: number) =>
    d.decode(h.subarray(at, at + len)).replace(/\0.*$/s, "").trim();
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    const name = field(h, 0, 100);
    if (!name) break;
    const size = parseInt(field(h, 124, 12), 8) || 0;
    const type = field(h, 156, 1) || "0";
    const body = off + 512;
    if (type === "0" && name.replace(/^.*\//, "") === "ai-bootstrap") {
      return tar.slice(body, body + size);
    }
    off = body + Math.ceil(size / 512) * 512;
  }
  throw new Error("no ai-bootstrap in the archive");
}

/**
 * ai-bootstrap.exe from a zip, found through the central directory (which
 * holds the sizes even when the local headers do not). Stored or deflated.
 */
async function fromZip(data: Uint8Array): Promise<Uint8Array> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip: no end of central directory");
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const d = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error("zip: bad central directory");
    const method = v.getUint16(at + 10, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = d.decode(data.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (!/(^|\/)ai-bootstrap(\.exe)?$/i.test(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const body = data.subarray(start, start + size);
    if (method === 0) return body.slice();
    if (method !== 8) throw new Error(`zip: ${name} uses compression method ${method}`);
    const s = new Blob([body as BlobPart]).stream().pipeThrough(
      new DecompressionStream("deflate-raw"),
    );
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  throw new Error("no ai-bootstrap.exe in the zip");
}

/** The ai-bootstrap binary inside a package downloaded as `name`. */
export async function unpack(name: string, data: Uint8Array): Promise<Uint8Array> {
  if (name.endsWith(".sh")) return await fromScript(data);
  if (name.endsWith(".tar.gz")) return await fromTarGz(data);
  if (name.endsWith(".zip")) return await fromZip(data);
  throw new Error(`cannot unpack ${name} here`);
}
