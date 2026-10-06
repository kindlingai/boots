// OpenAI-compatible chat (llama.cpp, Ollama, vLLM, SGLang, LM Studio,
// LiteLLM, OpenRouter, OpenAI) with streaming and tool calls, plus the
// router that prefers the smart model and falls back to the bootstrap one.

import { TextLineStream } from "@std/streams";
import { secrets } from "./secrets.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface Endpoint {
  label: string;
  baseUrl: string;
  model: string;
  /** Env var holding the key, if any. */
  keyEnv?: string;
  /** Key held only in the in-memory store, under this URL. */
  keyInMemory?: boolean;
  /** Rough context budget in characters. */
  contextChars: number;
  /** Overrides the tier guessed from the model name (see prompts.ts tierOf). */
  tier?: "base" | "full";
  /**
   * Sampling parameters sent with every request (temperature, top_p, ...).
   * None by default: the server's own defaults apply, and some servers
   * reject parameters they do not support.
   */
  sampling?: Record<string, unknown>;
}

/** The small local model we run ourselves: kept steady. */
export const BOOTSTRAP_SAMPLING = { temperature: 0.3 };

export class LLMError extends Error {
  constructor(msg: string, readonly retryable: boolean) {
    super(msg);
  }
}

function apiKey(ep: Endpoint): string | undefined {
  if (ep.keyInMemory) return secrets.get([ep.baseUrl], "apikey");
  if (ep.keyEnv) return Deno.env.get(ep.keyEnv);
  return undefined;
}

export interface Reply {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finish: string;
}

export interface StreamSink {
  content?: (s: string) => void;
  reasoning?: (s: string) => void;
}

const TOOL_TAG = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

/** Splits <think> blocks out of content and recovers Qwen-style text tool calls. */
export function normalize(
  content: string,
  calls: ToolCall[],
): { content: string; reasoning: string; calls: ToolCall[] } {
  let reasoning = "";
  content = content.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_, r) => {
    reasoning += r;
    return "";
  });
  if (!calls.length && content.includes("<tool_call>")) {
    let i = 0;
    content = content.replace(TOOL_TAG, (_, json) => {
      try {
        const o = JSON.parse(json);
        calls.push({
          id: `call_text_${i++}`,
          type: "function",
          function: {
            name: String(o.name),
            arguments: typeof o.arguments === "string"
              ? o.arguments
              : JSON.stringify(o.arguments ?? {}),
          },
        });
        return "";
      } catch {
        return _;
      }
    });
  }
  return { content: content.trim(), reasoning: reasoning.trim(), calls };
}

export async function chat(
  ep: Endpoint,
  messages: Message[],
  tools: ToolDef[],
  sink: StreamSink = {},
  signal?: AbortSignal,
  /** Overrides the endpoint's temperature for this request (e.g. 0 for a classifier). */
  temperature?: number,
  /** "required": the server must answer with a tool call (llama.cpp enforces it with a grammar). */
  toolChoice?: "required",
  /** Internal: retrying after a 400 without the sampling parameters. */
  plain = false,
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = apiKey(ep);
  if (key) headers.authorization = `Bearer ${key}`;
  if (ep.baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/mmastrac/ai-bootstrap";
    headers["X-Title"] = "ai-bootstrap";
  }
  const sampling: Record<string, unknown> = plain ? {} : { ...ep.sampling };
  if (!plain && temperature !== undefined) sampling.temperature = temperature;
  const body = {
    ...sampling,
    model: ep.model,
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length && toolChoice ? toolChoice : undefined,
    stream: true,
  };
  let r: Response;
  try {
    r = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new LLMError(`${ep.label}: ${(e as Error).message}`, true);
  }
  if (!r.ok) {
    const text = (await r.text()).slice(0, 500);
    // A server that does not support tool_choice, or a sampling parameter:
    // ask again without it.
    if (r.status === 400 && body.tool_choice) {
      return await chat(ep, messages, tools, sink, signal, temperature, undefined, plain);
    }
    if (r.status === 400 && Object.keys(sampling).length) {
      return await chat(ep, messages, tools, sink, signal, undefined, undefined, true);
    }
    throw new LLMError(
      `${ep.label}: HTTP ${r.status}: ${text}`,
      r.status >= 500 || r.status === 429 || r.status === 404,
    );
  }
  let content = "";
  let reasoning = "";
  let finish = "";
  const calls: ToolCall[] = [];
  const type = r.headers.get("content-type") ?? "";
  if (!type.includes("event-stream")) {
    // Some servers ignore stream: true.
    const j = await r.json();
    const m = j.choices?.[0]?.message ?? {};
    content = m.content ?? "";
    reasoning = m.reasoning_content ?? m.reasoning ?? "";
    for (const c of m.tool_calls ?? []) calls.push(c);
    finish = j.choices?.[0]?.finish_reason ?? "";
    if (content) sink.content?.(content);
  } else {
    let inThink = false;
    const lines = r.body!.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") break;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.error) {
        throw new LLMError(`${ep.label}: ${j.error.message ?? JSON.stringify(j.error)}`, true);
      }
      const ch = j.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta ?? {};
      const r2 = d.reasoning_content ?? d.reasoning;
      if (typeof r2 === "string" && r2) {
        reasoning += r2;
        sink.reasoning?.(r2);
      }
      if (typeof d.content === "string" && d.content) {
        content += d.content;
        // Stream visible text, hiding inline <think> and <tool_call> blocks.
        let piece = d.content;
        if (piece.includes("<think>")) inThink = true;
        if (inThink) {
          if (piece.includes("</think>")) {
            inThink = false;
            piece = piece.slice(piece.indexOf("</think>") + 8);
          } else piece = "";
        }
        if (piece && !content.includes("<tool_call>")) sink.content?.(piece);
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
  }
  const n = normalize(content, calls.filter(Boolean));
  n.calls.forEach((c, i) => (c.id ||= `call_${i}`));
  return { content: n.content, reasoning: reasoning + n.reasoning, toolCalls: n.calls, finish };
}

/** A cheap liveness check: list models. */
export async function reachable(ep: Endpoint, ms = 4000): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    const key = apiKey(ep);
    if (key) headers.authorization = `Bearer ${key}`;
    const r = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/models`, {
      headers,
      signal: AbortSignal.timeout(ms),
    });
    await r.body?.cancel();
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * The bootstrap model is used until a smarter one is registered, and again
 * whenever the smarter one stops answering. A failed smart model is retried
 * after a cool-down.
 */
/** A local bootstrap model that can be stopped to make room and started again. */
export interface BootstrapControl {
  running(): boolean;
  stop(): Promise<void>;
  start(): Promise<Endpoint>;
}

export class Router {
  smart: Endpoint | null = null;
  private smartDownUntil = 0;
  onNotice: (s: string) => void = () => {};

  constructor(public bootstrap: Endpoint, private control?: BootstrapControl) {}

  /** The bootstrap is answering (or is not ours to stop). */
  bootstrapUp(): boolean {
    return !this.control || this.control.running();
  }

  /**
   * Stops the local bootstrap so the full model gets its memory. True if it
   * was running, so the caller knows to bring it back if the full model fails.
   */
  async handover(): Promise<boolean> {
    if (!this.control?.running()) return false;
    this.onNotice(`handing over: stopping ${this.bootstrap.label} to make room for the full model`);
    await this.control.stop();
    return true;
  }

  /** Starts the bootstrap again if it was handed over. */
  async ensureBootstrap(): Promise<Endpoint> {
    if (this.control && !this.control.running()) {
      this.onNotice(`starting ${this.bootstrap.label} again`);
      this.bootstrap = await this.control.start();
    }
    return this.bootstrap;
  }

  current(): Endpoint {
    return this.smart && Date.now() >= this.smartDownUntil ? this.smart : this.bootstrap;
  }

  usingFallback(): boolean {
    return !!this.smart && Date.now() < this.smartDownUntil;
  }

  setSmart(ep: Endpoint | null): void {
    this.smart = ep;
    this.smartDownUntil = 0;
  }

  /**
   * `tools` may depend on the model that ends up answering (the smart one
   * may fail over to the bootstrap mid-request).
   */
  async chat(
    messages: () => Message[],
    tools: ToolDef[] | ((ep: Endpoint) => ChatShape),
    sink: StreamSink,
    signal?: AbortSignal,
  ): Promise<Reply> {
    const shape = (e: Endpoint): ChatShape => typeof tools === "function" ? tools(e) : { tools };
    const send = (e: Endpoint) => {
      const s = shape(e);
      return chat(e, messages(), s.tools, sink, signal, undefined, s.toolChoice);
    };
    const ep = this.current();
    if (ep === this.smart) {
      try {
        return await send(ep);
      } catch (e) {
        if (signal?.aborted || !(e instanceof LLMError) || !e.retryable) throw e;
        this.smartDownUntil = Date.now() + 120_000;
        this.onNotice(
          `${ep.label} is unavailable (${e.message}); falling back to ${this.bootstrap.label}`,
        );
      }
    }
    return await send(await this.ensureBootstrap());
  }
}

export interface ChatShape {
  tools: ToolDef[];
  toolChoice?: "required";
}
