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
  /**
   * The server's chat template wants tool-call arguments as objects, not the
   * JSON strings of the OpenAI format (newer Qwen templates iterate them with
   * `| items`; vLLM converts, some MLX and llama servers do not). Learnt from
   * the first "Can only get item pairs from a mapping" error.
   */
  toolArgsAsObjects?: boolean;
  /** The server refused chat_template_kwargs (learnt from a 400): /thinking off cannot reach it. */
  noTemplateKwargs?: boolean;
  /**
   * From a probe (probe.ts): the request parameters for thinking (normal
   * requests) and for not thinking (where thinking is turned off).
   */
  profile?: {
    thinking: Record<string, unknown>;
    nonThinking: Record<string, unknown>;
    timeouts?: { thinkingMs: number; nonThinkingMs: number };
  };
}

/**
 * Asks the chat template not to think: Qwen, GLM and Gemma read
 * enable_thinking, DeepSeek reads thinking. llama.cpp, vLLM and SGLang pass
 * these to the template; a server that refuses them is asked again without.
 */
const THINKING_OFF = { enable_thinking: false, thinking: false };

/** A server's way of saying the request is longer than the model's context. */
export const CONTEXT_TOO_LONG =
  /context[ _-]?(length|size|window)|exceeds? (the )?(available |maximum )?context|maximum context|too many tokens|prompt is too long|input is too long|exceed_context/i;

/** Most output tokens asked for in one reply. */
const MAX_OUTPUT = 32_768;

/**
 * max_tokens for a request: what the context has left after the prompt
 * (counted generously, at 3 characters a token), at most MAX_OUTPUT; 0 (send
 * none) when that leaves too little to be worth stating.
 */
export function outputRoom(ep: Endpoint, messages: Message[], tools: ToolDef[] = []): number {
  const prompt = Math.ceil(
    (JSON.stringify(messages).length + (tools.length ? JSON.stringify(tools).length : 0)) / 3,
  );
  const left = Math.floor(ep.contextChars / 3) - prompt - 256;
  return left >= 2048 ? Math.min(MAX_OUTPUT, left) : 0;
}

/** The small local model we run ourselves: kept steady. */
export const BOOTSTRAP_SAMPLING = { temperature: 0.3 };

export class LLMError extends Error {
  constructor(msg: string, readonly retryable: boolean) {
    super(msg);
  }
}

export function apiKey(ep: Endpoint): string | undefined {
  if (ep.keyInMemory) return secrets.get([ep.baseUrl], "apikey");
  if (ep.keyEnv) return Deno.env.get(ep.keyEnv);
  return undefined;
}

export interface Reply {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finish: string;
  /** The max_tokens the request asked for; 0 when it left the server's default. */
  maxTokens?: number;
}

export interface StreamSink {
  content?: (s: string) => void;
  reasoning?: (s: string) => void;
  /** Each streamed chunk (text, thinking or tool-call arguments): about one token. */
  token?: () => void;
}

/**
 * The part of streamed content that is text for the user: <think> blocks
 * removed (an unclosed one hides the rest), cut at the first <tool_call>,
 * and without a trailing "<" that could be the start of either tag.
 */
export function visibleSoFar(content: string): string {
  let t = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = t.indexOf("<think>");
  if (open >= 0) t = t.slice(0, open);
  const call = t.indexOf("<tool_call>");
  if (call >= 0) t = t.slice(0, call);
  for (const tag of ["<tool_call>", "<think>"]) {
    for (let k = tag.length - 1; k > 0; k--) {
      if (t.endsWith(tag.slice(0, k))) {
        t = t.slice(0, -k);
        break;
      }
    }
  }
  return t;
}

// A text tool call, closed or cut off at the end of the reply.
const TOOL_TAG = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;

/**
 * One text tool call: the JSON form ({"name", "arguments"}) or the XML form
 * Qwen3-Coder and Qwen3.5+ templates use
 * (<function=run><parameter=command>ls</parameter></function>).
 */
export function parseTextCall(body: string): { name: string; arguments: string } | null {
  const t = body.trim();
  const json = t.match(/^\{[\s\S]*\}/);
  if (json) {
    try {
      const o = JSON.parse(json[0]);
      if (!o.name) return null;
      return {
        name: String(o.name),
        arguments: typeof o.arguments === "string"
          ? o.arguments
          : JSON.stringify(o.arguments ?? o.parameters ?? {}),
      };
    } catch {
      return null;
    }
  }
  const fn = t.match(/<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/);
  if (!fn) return null;
  const args: Record<string, unknown> = {};
  for (
    const p of fn[2].matchAll(
      /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?(?:<\/parameter>|(?=<parameter=)|$)/g,
    )
  ) {
    const v = p[2];
    // Numbers, booleans and objects come as JSON; anything else is text.
    let val: unknown = v;
    if (/^\s*(-?\d+(\.\d+)?|true|false|null|[{[][\s\S]*)\s*$/.test(v)) {
      try {
        val = JSON.parse(v);
      } catch {
        // text after all
      }
    }
    args[p[1]] = val;
  }
  return { name: fn[1], arguments: JSON.stringify(args) };
}

function textCalls(text: string, calls: ToolCall[]): string {
  return text.replace(TOOL_TAG, (all, body) => {
    const c = parseTextCall(body);
    if (!c) return all;
    calls.push({ id: `call_text_${calls.length}`, type: "function", function: c });
    return "";
  });
}

/**
 * Splits <think> blocks out of content and recovers Qwen-style text tool
 * calls, from the content or, when the model called a tool before closing
 * its thinking, from the reasoning.
 */
export function normalize(
  content: string,
  calls: ToolCall[],
  reasoningIn = "",
): { content: string; reasoning: string; calls: ToolCall[] } {
  let reasoning = "";
  content = content.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_, r) => {
    reasoning += r;
    return "";
  });
  if (!calls.length && content.includes("<tool_call>")) content = textCalls(content, calls);
  if (!calls.length && !content.trim()) {
    for (const r of [reasoningIn, reasoning]) {
      if (r.includes("<tool_call>")) textCalls(r, calls);
      if (calls.length) break;
    }
  }
  return { content: content.trim(), reasoning: reasoning.trim(), calls };
}

/** Jinja errors from a template that expects tool-call arguments as a mapping. */
const TEMPLATE_WANTS_OBJECTS =
  /item pairs from a mapping|object has no attribute .?items|'str' object has no attribute|arguments.*(mapping|dict)/i;

/** The messages with each tool call's JSON-string arguments parsed into objects. */
export function withObjectArgs(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!m.tool_calls?.length) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map((c) => {
        let args: unknown = c.function.arguments;
        if (typeof args === "string") {
          try {
            args = args.trim() ? JSON.parse(args) : {};
          } catch {
            args = { input: args };
          }
        }
        return { ...c, function: { ...c.function, arguments: args as string } };
      }),
    };
  });
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
  /** Ask the model not to think (/thinking off). */
  thinkingOff = false,
  /** Internal: retrying a context overflow without max_tokens. */
  noRoom = false,
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = apiKey(ep);
  if (key) headers.authorization = `Bearer ${key}`;
  if (ep.baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/kindlingai/boots";
    headers["X-Title"] = "ai-bootstrap";
  }
  const sampling: Record<string, unknown> = plain ? {} : { ...ep.sampling };
  if (!plain && temperature !== undefined) sampling.temperature = temperature;
  // Room to answer: some servers' default output limit is small (MLX: 512),
  // which a thinking model spends before it says anything. Sized to what the
  // context has left, so it is never refused as too long.
  const room = outputRoom(ep, messages, tools);
  if (!plain && !noRoom && room && !("max_tokens" in sampling)) sampling.max_tokens = room;
  // A probed endpoint's own settings for thinking and not thinking; otherwise
  // the usual chat-template switch when thinking is turned off.
  const mode: Record<string, unknown> = ep.profile
    ? { ...(thinkingOff ? ep.profile.nonThinking : ep.profile.thinking) }
    : thinkingOff
    ? { chat_template_kwargs: THINKING_OFF }
    : {};
  if (ep.noTemplateKwargs) delete mode.chat_template_kwargs;
  const body: Record<string, unknown> = {
    ...sampling,
    ...mode,
    model: ep.model,
    messages: ep.toolArgsAsObjects ? withObjectArgs(messages) : messages,
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
    // A template that iterates tool-call arguments as a mapping: send them
    // as objects from now on.
    // Too long for the context. max_tokens counts against it on some servers
    // (vLLM): try once without; otherwise it is the caller's to shorten.
    if (r.status === 400 && CONTEXT_TOO_LONG.test(text)) {
      if ("max_tokens" in body && !noRoom) {
        return await chat(
          ep,
          messages,
          tools,
          sink,
          signal,
          temperature,
          toolChoice,
          plain,
          thinkingOff,
          true,
        );
      }
      throw new LLMError(`${ep.label}: HTTP ${r.status}: ${text}`, false);
    }
    if (
      r.status === 400 && !ep.toolArgsAsObjects && TEMPLATE_WANTS_OBJECTS.test(text) &&
      messages.some((m) => m.tool_calls?.length)
    ) {
      ep.toolArgsAsObjects = true;
      return await chat(
        ep,
        messages,
        tools,
        sink,
        signal,
        temperature,
        toolChoice,
        plain,
        thinkingOff,
      );
    }
    // A probed setting the server no longer takes: without it.
    if (r.status === 400 && ep.profile && Object.keys(mode).length) {
      return await chat(
        { ...ep, profile: undefined },
        messages,
        tools,
        sink,
        signal,
        temperature,
        toolChoice,
        plain,
        thinkingOff,
        noRoom,
      );
    }
    if (r.status === 400 && body.chat_template_kwargs) {
      ep.noTemplateKwargs = true;
      return await chat(
        ep,
        messages,
        tools,
        sink,
        signal,
        temperature,
        toolChoice,
        plain,
        thinkingOff,
      );
    }
    if (r.status === 400 && body.tool_choice) {
      return await chat(
        ep,
        messages,
        tools,
        sink,
        signal,
        temperature,
        undefined,
        plain,
        thinkingOff,
      );
    }
    if (r.status === 400 && Object.keys(sampling).length) {
      return await chat(ep, messages, tools, sink, signal, undefined, undefined, true, thinkingOff);
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
    let shown = 0;
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
      if (d.content || d.reasoning_content || d.reasoning || d.tool_calls?.length) sink.token?.();
      const r2 = d.reasoning_content ?? d.reasoning;
      if (typeof r2 === "string" && r2) {
        reasoning += r2;
        sink.reasoning?.(r2);
      }
      if (typeof d.content === "string" && d.content) {
        content += d.content;
        // Stream what is surely visible text: outside <think> blocks, before
        // any <tool_call>, holding back a tag that may still be arriving.
        const visible = visibleSoFar(content);
        if (visible.length > shown) {
          sink.content?.(visible.slice(shown));
          shown = visible.length;
        }
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
  const n = normalize(content, calls.filter(Boolean), reasoning);
  n.calls.forEach((c, i) => (c.id ||= `call_${i}`));
  return {
    content: n.content,
    reasoning: reasoning + n.reasoning,
    toolCalls: n.calls,
    finish,
    maxTokens: typeof sampling.max_tokens === "number" ? sampling.max_tokens : 0,
  };
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
  /** /thinking off: ask every model the agent talks to not to think. */
  thinkingOff = false;
  /** Just the next request without thinking (after one that thought until it ran out). */
  thinkingOffOnce = false;
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
    if (ep) this.onSmart(ep);
  }

  /** A full model was set: the session attaches its probed profile (or probes it). */
  onSmart: (ep: Endpoint) => void = () => {};

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
    const quiet = this.thinkingOff || this.thinkingOffOnce;
    this.thinkingOffOnce = false;
    const send = (e: Endpoint) => {
      const s = shape(e);
      return chat(
        e,
        messages(),
        s.tools,
        sink,
        signal,
        undefined,
        s.toolChoice,
        false,
        quiet,
      );
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
