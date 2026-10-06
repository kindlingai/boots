// Release packages (made by scripts/package.sh): the name of the package for
// each target, and how to get the ai-bootstrap binary back out of one.

/** The release asset holding the ai-bootstrap binary for `target`. */
export function packageName(target: string): string {
  const ext = target.includes("windows") ? "zip" : target.includes("darwin") ? "sh" : "tar.gz";
  return `ai-bootstrap-${target}.${ext}`;
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

/** The ai-bootstrap binary inside a package downloaded as `name`. */
export async function unpack(name: string, data: Uint8Array): Promise<Uint8Array> {
  if (name.endsWith(".sh")) return await fromScript(data);
  if (name.endsWith(".tar.gz")) return await fromTarGz(data);
  throw new Error(`cannot unpack ${name} here`);
}
