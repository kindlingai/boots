// A minimal MCP client: stdio and streamable-HTTP servers, tools only.
//
// Servers are configured in <data>/mcp.json, in the usual shape:
//
//   { "mcpServers": {
//       "fs":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv"] },
//       "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } } } }

import { join } from "@std/path";
import { TextLineStream } from "@std/streams";
import { dataDir, ensureDir } from "./platform.ts";
import { VERSION } from "./platform.ts";

export interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const PROTOCOL = "2025-06-18";

interface Transport {
  request(method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

class StdioTransport implements Transport {
  private proc: Deno.ChildProcess;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  stderr = "";

  constructor(cfg: ServerConfig) {
    const proc = this.proc = new Deno.Command(cfg.command!, {
      args: cfg.args ?? [],
      env: cfg.env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.writer = this.proc.stdin.getWriter();
    this.pump();
    (async () => {
      for await (const c of proc.stderr.pipeThrough(new TextDecoderStream())) {
        this.stderr = (this.stderr + c).slice(-2000);
      }
    })().catch(() => {});
  }

  private async pump() {
    try {
      const lines = this.proc.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(
        new TextLineStream(),
      );
      for await (const line of lines) {
        if (!line.trim()) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
          const p = this.pending.get(m.id);
          if (!p) continue;
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
          else p.resolve(m.result);
        } else if (m.id !== undefined && m.method) {
          // Server-to-client requests (ping, roots/list, sampling): answer minimally.
          const result = m.method === "ping" ? {} : undefined;
          await this.send(
            result
              ? { jsonrpc: "2.0", id: m.id, result }
              : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported" } },
          );
        }
      }
    } catch {
      // fall through
    }
    for (const p of this.pending.values()) {
      p.reject(new Error(`server exited${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
    }
    this.pending.clear();
  }

  private async send(m: unknown) {
    await this.writer.write(new TextEncoder().encode(JSON.stringify(m) + "\n"));
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params }).catch(reject);
    });
  }

  async notify(method: string, params?: unknown) {
    await this.send({ jsonrpc: "2.0", method, params });
  }

  async close() {
    await this.writer.close().catch(() => {});
    try {
      this.proc.kill();
    } catch {
      // gone
    }
  }
}

class HttpTransport implements Transport {
  private next = 1;
  private session: string | null = null;

  constructor(private cfg: ServerConfig) {}

  private async post(body: unknown, wantId?: number): Promise<any> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      ...(this.cfg.headers ?? {}),
    };
    if (this.session) headers["mcp-session-id"] = this.session;
    const r = await fetch(this.cfg.url!, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    if (wantId === undefined) {
      await r.body?.cancel();
      return;
    }
    const type = r.headers.get("content-type") ?? "";
    const pick = (m: any) => {
      if (m?.id !== wantId) return undefined;
      if (m.error) throw new Error(m.error.message ?? JSON.stringify(m.error));
      return { v: m.result };
    };
    if (type.includes("event-stream")) {
      const lines = r.body!.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
      for await (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const got = pick(JSON.parse(line.slice(5)));
          if (got) {
            await lines.cancel().catch(() => {});
            return got.v;
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
      throw new Error("stream ended without a response");
    }
    const j = await r.json();
    for (const m of Array.isArray(j) ? j : [j]) {
      const got = pick(m);
      if (got) return got.v;
    }
    throw new Error("no response");
  }

  request(method: string, params?: unknown) {
    const id = this.next++;
    return this.post({ jsonrpc: "2.0", id, method, params }, id);
  }

  async notify(method: string, params?: unknown) {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  async close() {
    if (!this.session) return;
    await fetch(this.cfg.url!, { method: "DELETE", headers: { "mcp-session-id": this.session } })
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }
}

class Client {
  tools: McpTool[] = [];
  private constructor(private t: Transport) {}

  static async connect(cfg: ServerConfig): Promise<Client> {
    const t: Transport = cfg.url ? new HttpTransport(cfg) : new StdioTransport(cfg);
    const c = new Client(t);
    await withTimeout(
      t.request("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "ai-bootstrap", version: VERSION },
      }),
      30_000,
    );
    await t.notify("notifications/initialized");
    let cursor: string | undefined;
    do {
      const r = await withTimeout(t.request("tools/list", cursor ? { cursor } : {}), 30_000);
      c.tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor);
    return c;
  }

  async call(name: string, args: unknown): Promise<string> {
    const r = await withTimeout(
      this.t.request("tools/call", { name, arguments: args ?? {} }),
      300_000,
    );
    const parts = (r.content ?? []).map((c: any) =>
      c.type === "text"
        ? c.text
        : c.type === "resource"
        ? (c.resource?.text ?? `[resource ${c.resource?.uri}]`)
        : `[${c.type}]`
    );
    if (r.structuredContent && !parts.length) parts.push(JSON.stringify(r.structuredContent));
    const text = parts.join("\n");
    return r.isError ? `tool error: ${text}` : text;
  }

  close() {
    return this.t.close();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((
      _,
      rej,
    ) => (t = setTimeout(() => rej(new Error(`no answer in ${ms / 1000}s`)), ms))),
  ]);
}

export class McpManager {
  private clients = new Map<string, Client>();

  constructor(readonly configPath = join(dataDir(), "mcp.json")) {}

  async servers(): Promise<Record<string, ServerConfig>> {
    try {
      return JSON.parse(await Deno.readTextFile(this.configPath)).mcpServers ?? {};
    } catch {
      return {};
    }
  }

  async add(name: string, cfg: ServerConfig): Promise<void> {
    const all = await this.servers();
    all[name] = cfg;
    await ensureDir(join(this.configPath, ".."));
    await Deno.writeTextFile(this.configPath, JSON.stringify({ mcpServers: all }, null, 2) + "\n");
    const old = this.clients.get(name);
    this.clients.delete(name);
    await old?.close();
  }

  private async client(name: string): Promise<Client> {
    const have = this.clients.get(name);
    if (have) return have;
    const cfg = (await this.servers())[name];
    if (!cfg) {
      throw new Error(
        `no MCP server ${name}; configured: ${
          Object.keys(await this.servers()).join(", ") || "none"
        }`,
      );
    }
    const c = await Client.connect(cfg);
    this.clients.set(name, c);
    return c;
  }

  async list(name?: string): Promise<string> {
    const names = name ? [name] : Object.keys(await this.servers());
    if (!names.length) {
      return `no MCP servers configured (${this.configPath}); add one with mcp_add`;
    }
    const out: string[] = [];
    for (const n of names) {
      try {
        const c = await this.client(n);
        out.push(`## ${n}`);
        for (const t of c.tools) {
          const schema = JSON.stringify(t.inputSchema ?? {});
          out.push(
            `- ${t.name}: ${(t.description ?? "").split("\n")[0].slice(0, 200)}\n  args: ${
              schema.slice(0, 600)
            }`,
          );
        }
      } catch (e) {
        out.push(`## ${n}\n(unavailable: ${(e as Error).message})`);
      }
    }
    return out.join("\n");
  }

  async call(server: string, tool: string, args: unknown): Promise<string> {
    return await (await this.client(server)).call(tool, args);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
  }
}
