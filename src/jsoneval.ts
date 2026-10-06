// json_eval: the model edits a JSON memory with a little JavaScript. The code
// runs in a separate ai-bootstrap process that first gives up every
// permission (no files, network, environment, processes or FFI), with the
// document on the global `json` and the caller's data on `input`. Whatever
// `json` holds when the code finishes is the new document.

import { selfArgv } from "./platform.ts";

export interface EvalResult {
  /** The new document, when the code ran. */
  json?: unknown;
  /** What the code printed with console.log. */
  logs: string[];
  error?: string;
}

const PERMISSIONS = ["read", "write", "net", "env", "run", "ffi", "sys", "import"] as const;

/** The child: reads {json, input, code} on stdin, writes an EvalResult on stdout. */
export async function jsonEvalMain(): Promise<number> {
  const req = JSON.parse(await new Response(Deno.stdin.readable).text());
  for (const name of PERMISSIONS) Deno.permissions.revokeSync({ name });
  const logs: string[] = [];
  const show = (a: unknown[]) =>
    a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log =
    console.info =
    console.warn =
    console.error =
      (...a: unknown[]) => {
        if (logs.length < 100) logs.push(show(a).slice(0, 2000));
      };
  const g = globalThis as Record<string, unknown>;
  g.json = req.json;
  g.input = req.input;
  let out: EvalResult;
  try {
    // Indirect eval: the code runs at global scope, so `json = {...}` replaces the global.
    (0, eval)(String(req.code));
    if (g.json === undefined) throw new Error("json is undefined after the code ran");
    // A plain JSON round trip: functions, cycles and the like fail here.
    out = { json: JSON.parse(JSON.stringify(g.json)), logs };
  } catch (e) {
    out = { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), logs };
  }
  Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify(out) + "\n"));
  return 0;
}

/** Runs `code` over `json` in the sandbox. Times out after `timeoutMs`. */
export async function jsonEval(
  json: unknown,
  input: unknown,
  code: string,
  timeoutMs = 5000,
): Promise<EvalResult> {
  const [cmd, ...args] = selfArgv();
  let p: Deno.ChildProcess;
  try {
    p = new Deno.Command(cmd, {
      args: [...args, "--json-eval"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    return { logs: [], error: `could not start the sandbox: ${(e as Error).message}` };
  }
  const timer = setTimeout(() => {
    try {
      p.kill("SIGKILL");
    } catch {
      // gone
    }
  }, timeoutMs);
  try {
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode(JSON.stringify({ json, input, code })));
    await w.close();
    const o = await p.output();
    const text = new TextDecoder().decode(o.stdout).trim().split("\n").at(-1) ?? "";
    if (!o.success || !text) {
      return {
        logs: [],
        error: o.signal === "SIGKILL"
          ? `timed out after ${timeoutMs / 1000}s (an endless loop?)`
          : `the sandbox failed: ${new TextDecoder().decode(o.stderr).trim().slice(-500)}`,
      };
    }
    return JSON.parse(text) as EvalResult;
  } finally {
    clearTimeout(timer);
  }
}
