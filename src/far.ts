// `ai-bootstrap --far`: the agent at the far end of an ssh hop. It speaks RPC on
// stdin/stdout, runs requests with its own Host, and sends any password
// question back up to whoever started it.

import { Rpc } from "./rpc.ts";
import { Host } from "./host.ts";
import { setUpstream } from "./ssh.ts";

export async function farMain(): Promise<number> {
  const rpc = new Rpc(Deno.stdin.readable, Deno.stdout.writable);
  const host = new Host(
    (req) => rpc.call("ask", req),
    (s) => console.error(s),
  );
  rpc.handler = (op, args, via) => host.handle(op, args, via);
  host.onLine = (token, line) => void rpc.call("exec_line", { token, line }).catch(() => {});
  // Builds for machines further down come from up the chain, not the internet.
  setUpstream((op, args) => rpc.call(op, args));
  await rpc.closed;
  await host.closeAll();
  return 0;
}
