// SSH_ASKPASS plumbing. ssh runs this same binary to ask for a password;
// it connects back over loopback with a one-time token, and the harness
// answers from the in-memory store or by prompting the user. On a far host
// the question travels up the hop chain to the near side.

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import type { Asker } from "./secrets.ts";
import { cacheDir, ensureDir, isCompiled, isWindows, selfArgv } from "./platform.ts";

export interface AskpassServer {
  env: Record<string, string>;
  close(): void;
}

async function launcher(): Promise<string> {
  if (isCompiled()) return Deno.execPath();
  // Under `deno run`, ssh needs a single program path.
  const dir = join(cacheDir(), "dev");
  await ensureDir(dir);
  const argv = [...selfArgv(), "--askpass"];
  if (isWindows) {
    const p = join(dir, "askpass.cmd");
    await Deno.writeTextFile(p, `@echo off\r\n${argv.map((a) => `"${a}"`).join(" ")} %*\r\n`);
    return p;
  }
  const p = join(dir, "askpass.sh");
  const q = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`;
  await Deno.writeTextFile(p, `#!/bin/sh\nexec ${argv.map(q).join(" ")} "$@"\n`);
  await Deno.chmod(p, 0o755);
  return p;
}

/** Serves askpass requests for one ssh connection attempt. */
export async function startAskpass(ask: Asker): Promise<AskpassServer> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const token = encodeHex(crypto.getRandomValues(new Uint8Array(16)));
  let passwords = 0;
  (async () => {
    for await (const conn of listener) {
      (async () => {
        try {
          const req = JSON.parse(await readAll(conn));
          if (req.token !== token) return;
          const prompt = String(req.prompt ?? "");
          const confirm = /yes\/no|fingerprint|continue connecting/i.test(prompt);
          const value = await ask({
            kind: confirm ? "confirm" : "ssh",
            path: [],
            prompt: prompt.trim() || "ssh password",
            attempt: confirm ? 0 : passwords++,
          });
          await conn.write(new TextEncoder().encode(JSON.stringify({ value })));
        } catch {
          // a broken askpass call makes ssh fail its auth attempt; fine
        } finally {
          try {
            conn.close();
          } catch {
            // closed
          }
        }
      })();
    }
  })().catch(() => {});
  const addr = listener.addr as Deno.NetAddr;
  return {
    env: {
      SSH_ASKPASS: await launcher(),
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: Deno.env.get("DISPLAY") ?? ":0",
      AIBOOT_ASKPASS_ADDR: `127.0.0.1:${addr.port}`,
      AIBOOT_ASKPASS_TOKEN: token,
    },
    close: () => {
      try {
        listener.close();
      } catch {
        // closed
      }
    },
  };
}

async function readAll(conn: Deno.Conn): Promise<string> {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(4096);
  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;
    chunks.push(buf.slice(0, n));
    const s = new TextDecoder().decode(chunks.at(-1));
    if (s.includes("\n")) break;
  }
  return new TextDecoder().decode(
    chunks.reduce((a, b) => new Uint8Array([...a, ...b]), new Uint8Array()),
  ).trim();
}

/** `ai-bootstrap` invoked by ssh as SSH_ASKPASS. Prints the answer for ssh. */
export async function askpassMain(prompt: string): Promise<number> {
  const addr = Deno.env.get("AIBOOT_ASKPASS_ADDR");
  const token = Deno.env.get("AIBOOT_ASKPASS_TOKEN");
  if (!addr || !token) return 1;
  const [hostname, port] = addr.split(":");
  try {
    const conn = await Deno.connect({ hostname, port: Number(port) });
    await conn.write(new TextEncoder().encode(JSON.stringify({ token, prompt }) + "\n"));
    const chunks: number[] = [];
    const buf = new Uint8Array(4096);
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      chunks.push(...buf.subarray(0, n));
    }
    conn.close();
    const { value } = JSON.parse(new TextDecoder().decode(new Uint8Array(chunks)));
    if (value === null || value === undefined) return 1;
    await Deno.stdout.write(new TextEncoder().encode(String(value) + "\n"));
    return 0;
  } catch {
    return 1;
  }
}
