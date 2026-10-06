// Release packages from scripts/package.sh: the self-extracting script works,
// and binaryFor gets the binary back out of a downloaded package.
import { fromFileUrl, join } from "@std/path";
import { assertEquals } from "@std/assert";
import { packageName, unpack } from "../src/package.ts";
import { binaryFor } from "../src/ssh.ts";

const script = fromFileUrl(new URL("../scripts/package.sh", import.meta.url));
// Needs sh, tar, gzip and zip.
const ignore = Deno.build.os === "windows";

async function sh(args: string[], cwd?: string): Promise<string> {
  const o = await new Deno.Command("sh", { args, cwd, stderr: "inherit" }).output();
  if (!o.success) throw new Error(`sh ${args.join(" ")} failed`);
  return new TextDecoder().decode(o.stdout);
}

async function fixture() {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  // A real (and on macOS, signed) executable, so the script's signature check passes.
  const bin = await Deno.readFile("/usr/bin/true");
  await Deno.writeFile(join(dir, "built"), bin);
  return { dir, bin };
}

Deno.test({ name: "package names", ignore }, () => {
  assertEquals(
    packageName("x86_64-unknown-linux-gnu"),
    "ai-bootstrap-x86_64-unknown-linux-gnu.tar.gz",
  );
  assertEquals(packageName("aarch64-apple-darwin"), "ai-bootstrap-aarch64-apple-darwin.sh");
  assertEquals(packageName("x86_64-pc-windows-msvc"), "ai-bootstrap-x86_64-pc-windows-msvc.zip");
});

Deno.test({ name: "the macOS script writes ai-bootstrap next to itself", ignore }, async () => {
  const { dir, bin } = await fixture();
  await sh([script, "aarch64-apple-darwin", join(dir, "built"), join(dir, "out")]);
  const pkg = join(dir, "out", packageName("aarch64-apple-darwin"));
  // Run from elsewhere: the binary lands beside the script, not in the cwd.
  const printed = await sh([pkg], Deno.cwd());
  assertEquals(printed, `Extracted.\n${join(dir, "out", "ai-bootstrap")}\n`);
  assertEquals(await Deno.readFile(join(dir, "out", "ai-bootstrap")), bin);
  const run = await new Deno.Command(join(dir, "out", "ai-bootstrap")).output();
  assertEquals(run.code, 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test({ name: "unpack the script and the tarball", ignore }, async () => {
  const { dir, bin } = await fixture();
  for (const t of ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]) {
    await sh([script, t, join(dir, "built"), join(dir, "out")]);
    const name = packageName(t);
    assertEquals(await unpack(name, await Deno.readFile(join(dir, "out", name))), bin);
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test({ name: "binaryFor downloads and unpacks a release", ignore }, async () => {
  const { dir, bin } = await fixture();
  const target = "aarch64-unknown-linux-gnu";
  const version = JSON.parse(
    await Deno.readTextFile(fromFileUrl(new URL("../deno.json", import.meta.url))),
  ).version;
  await sh([script, target, join(dir, "built"), join(dir, "rel", `v${version}`)]);
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen() {} }, async (req) => {
    try {
      return new Response(await Deno.readFile(join(dir, "rel", new URL(req.url).pathname)));
    } catch {
      return new Response("missing", { status: 404 });
    }
  });
  Deno.env.set("AIBOOT_RELEASES", `http://127.0.0.1:${server.addr.port}`);
  Deno.env.set("AIBOOT_CACHE", join(dir, "cache"));
  try {
    const path = await binaryFor(target, () => {});
    assertEquals(await Deno.readFile(path), bin);
  } finally {
    Deno.env.delete("AIBOOT_RELEASES");
    Deno.env.delete("AIBOOT_CACHE");
    ac.abort();
    await server.finished;
    await Deno.remove(dir, { recursive: true });
  }
});
