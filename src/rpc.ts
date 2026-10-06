// Bidirectional JSON-lines RPC between a near side and a far agent.
//
// Every protocol line starts with a marker so stray output on the channel
// (a chatty shell rc file, a MOTD) is shown rather than parsed.

import { TextLineStream } from "@std/streams";

export const MARK = "\x1eaiboot ";

type Req = { t: "req"; id: number; op: string; args: unknown; via?: string[] };
type Res = { t: "res"; id: number; ok: boolean; result?: unknown; error?: string };

export type Handler = (op: string, args: any, via: string[]) => Promise<unknown>;

export class RpcError extends Error {}

export class Rpc {
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private enc = new TextEncoder();
  private dead: string | null = null;
  readonly closed: Promise<void>;
  handler: Handler = (op) => Promise.reject(new RpcError(`no handler for ${op}`));

  constructor(
    readable: ReadableStream<Uint8Array>,
    writable: WritableStream<Uint8Array>,
    private onNoise: (line: string) => void = () => {},
  ) {
    this.writer = writable.getWriter();
    this.closed = this.pump(readable);
  }

  private async pump(readable: ReadableStream<Uint8Array>): Promise<void> {
    try {
      const lines = readable.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
      for await (const line of lines) {
        const at = line.indexOf(MARK);
        if (at < 0) {
          if (line.trim()) this.onNoise(line);
          continue;
        }
        let msg: Req | Res;
        try {
          msg = JSON.parse(line.slice(at + MARK.length));
        } catch {
          this.onNoise(line);
          continue;
        }
        if (msg.t === "res") this.settle(msg);
        else if (msg.t === "req") this.serve(msg);
      }
      this.fail("channel closed");
    } catch (e) {
      this.fail(`channel failed: ${(e as Error).message}`);
    }
  }

  private settle(m: Res): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new RpcError(m.error ?? "remote error"));
  }

  private async serve(m: Req): Promise<void> {
    let res: Res;
    try {
      res = { t: "res", id: m.id, ok: true, result: await this.handler(m.op, m.args, m.via ?? []) };
    } catch (e) {
      res = { t: "res", id: m.id, ok: false, error: (e as Error).message };
    }
    await this.send(res).catch(() => {});
  }

  private fail(why: string): void {
    if (this.dead) return;
    this.dead = why;
    for (const p of this.pending.values()) p.reject(new RpcError(why));
    this.pending.clear();
  }

  get alive(): boolean {
    return this.dead === null;
  }

  private async send(msg: Req | Res): Promise<void> {
    await this.writer.write(this.enc.encode(MARK + JSON.stringify(msg) + "\n"));
  }

  call<T = any>(op: string, args: unknown = {}, via: string[] = []): Promise<T> {
    if (this.dead) return Promise.reject(new RpcError(this.dead));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ t: "req", id, op, args, via: via.length ? via : undefined }).catch((e) => {
        this.pending.delete(id);
        reject(new RpcError(`send failed: ${e.message}`));
      });
    });
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch {
      // already closed
    }
  }
}
