// The conversation loop: ask what the user wants, plan, then execute step
// by step with tools.

import type { Message, Reply } from "./llm.ts";
import { type ChatShape, type Endpoint, LLMError } from "./llm.ts";
import { BASE_TOOLS, describe, renderPlan, type Session, TOOLS } from "./tools.ts";
import { currentTier, loadTemplates, systemPrompt, type Templates, tierOf } from "./prompts.ts";
import { secrets } from "./secrets.ts";
import { ask, bold, dim, Interrupted, plain, red, say, spinner, warn } from "./ui.ts";
import { emit } from "./frontend.ts";
import { clipTools, compact, isContextError, SUMMARY_PROMPT } from "./compact.ts";

const MAX_STEPS = 60;

/**
 * The small base model runs on rails: only the setup tools, and every step
 * must be a tool call (llama.cpp enforces it), talking to the user through
 * reply. AIBOOT_FORCE_TOOLS=0 drops the forcing. Others get the full tools.
 */
function shape(ep: Endpoint): ChatShape {
  if (tierOf(ep) === "base") {
    return {
      tools: BASE_TOOLS,
      toolChoice: Deno.env.get("AIBOOT_FORCE_TOOLS") === "0" ? undefined : "required",
    };
  }
  return { tools: TOOLS };
}

/**
 * Fits the history into the current model's budget: older tool output is
 * shortened, then the oldest turns go, but the last turn (from the latest
 * user message) always stays; if even that does not fit, its tool output is
 * shortened until it does. A request must keep a user message: servers
 * reject one without ("No user query found in messages").
 */
export function fit(history: Message[], budget: number): Message[] {
  const recent = 6;
  let msgs = history.map((m, i) =>
    m.role === "tool" && i < history.length - recent && m.content.length > 600
      ? {
        ...m,
        content: `${m.content.slice(0, 300)}\n...[older output cut]...\n${m.content.slice(-200)}`,
      }
      : m
  );
  const size = (ms: Message[]) =>
    ms.reduce((n, m) => n + m.content.length + JSON.stringify(m.tool_calls ?? "").length, 0);
  const lastUser = msgs.findLastIndex((m) => m.role === "user");
  if (lastUser > 0) {
    // Drop whole turns from the front, never the last one.
    let from = 0;
    while (size(msgs.slice(from)) > budget && from < lastUser) {
      from++;
      while (from < lastUser && msgs[from].role !== "user") from++;
    }
    msgs = msgs.slice(from);
  }
  // Still too long: shorten the biggest tool outputs, largest first.
  for (let guard = 0; size(msgs) > budget && guard < 50; guard++) {
    let big = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (
        msgs[i].role === "tool" && (big < 0 || msgs[i].content.length > msgs[big].content.length)
      ) {
        big = i;
      }
    }
    if (big < 0 || msgs[big].content.length <= 400) break;
    const c = msgs[big].content;
    const keep = Math.max(
      400,
      Math.floor(c.length - (size(msgs) - budget)) - 100,
      Math.floor(c.length / 2),
    );
    const head = Math.floor(keep * 0.6), tail = Math.floor(keep * 0.3);
    msgs[big] = {
      ...msgs[big],
      content: `${c.slice(0, head)}\n...[${
        c.length - head - tail
      } chars cut to fit the context]...\n${c.slice(-tail)}`,
    };
  }
  return msgs;
}

export class Agent {
  history: Message[] = [];
  /** When the restored turns were last active, if the history was restored. */
  restoredAt: string | null = null;
  private abort: AbortController | null = null;
  private busy = false;

  private templates: Templates | null = null;

  constructor(readonly s: Session, private extraContext: () => string) {}

  /** Adds to the history and to the conversation log. */
  private push(m: Message): void {
    this.history.push(m);
    this.s.transcript?.append(m);
  }

  /** Picks up the last turns of the previous session from the log. */
  async restore(turns = 6): Promise<number> {
    const r = await this.s.transcript?.restore(turns);
    if (!r) return 0;
    this.history = r.messages;
    this.restoredAt = r.at;
    return r.messages.filter((m) => m.role === "user").length;
  }

  /**
   * Summarises all but the last two turns with the model in use. Returns
   * what happened, for the user; null when there was nothing to compact.
   */
  async compact(signal?: AbortSignal): Promise<string | null> {
    const ep = this.s.router.current();
    const r = await compact(
      this.history,
      async (text) =>
        (await this.s.router.chat(
          () => [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: text }],
          [],
          {},
          signal,
        )).content,
      2,
      Math.floor(ep.contextChars * 0.6),
    );
    if (!r) return null;
    this.history = r.history;
    this.s.transcript?.append({
      role: "system",
      content: `(compacted ${r.summarized} turns)${r.summary ? `\n${r.summary}` : ""}`,
    });
    return `compacted ${r.summarized} older turn${r.summarized === 1 ? "" : "s"}${
      r.summary ? " into a summary" : " (no summary: they were dropped)"
    }; the last 2 are kept as they were`;
  }

  /** Stops a model reply or a running tool. False when no turn is running. */
  interrupt(): boolean {
    this.abort?.abort();
    return this.busy;
  }

  /** The system prompt as it stands now (it depends on which model is answering). */
  async system(): Promise<() => string> {
    this.templates ??= await loadTemplates();
    const t = this.templates;
    const [index, fleet, goals, docs, memories, remote, fresh] = await Promise.all([
      this.s.memory.index(),
      this.s.memory.fleet(),
      this.s.memory.goals(),
      this.s.memory.docNames(),
      this.s.memory.list(),
      this.s.memory.remote(),
      this.s.memory.isEmpty(),
    ]);
    const extra = this.extraContext();
    // Rendered lazily: the router may fall back to the bootstrap model mid-request.
    return () =>
      systemPrompt(t, this.s.router, {
        location: this.s.where(),
        os_name: this.s.here.info.osName,
        arch: this.s.here.info.arch,
        os: this.s.here.info.os,
        host: describe(this.s.here.info),
        shell: this.s.here.info.shell,
        models: this.s.here.info.models,
        scripts: this.s.here.info.scripts,
        free_port: this.s.here.info.freePort,
        hardware: this.s.here.info.hardware,
        docs,
        memories,
        memory_sync: remote,
        other_sources: extra,
        index,
        fleet,
        goals,
        plan: this.s.plan.length ? plain(renderPlan(this.s.plan)) : "(none yet)",
        fresh,
        failure: this.s.fullFailure,
        update: this.s.update,
        restored: this.restoredAt,
      });
  }

  private async messages(): Promise<() => Message[]> {
    const sys = await this.system();
    return () => {
      const content = sys();
      const budget = this.s.router.current().contextChars - content.length;
      return [{ role: "system", content }, ...fit(this.history, Math.max(budget, 4000))];
    };
  }

  async turn(userText: string): Promise<void> {
    this.busy = true;
    try {
      await this.steps(userText);
    } finally {
      this.busy = false;
    }
  }

  /** A whole assistant message at once. */
  private speak(text: string): void {
    emit({ type: "assistant", phase: "start" });
    emit({ type: "assistant", phase: "delta", text });
    emit({ type: "assistant", phase: "end" });
  }

  private async steps(userText: string): Promise<void> {
    this.push({ role: "user", content: userText });
    let compactions = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      this.abort = new AbortController();
      let reply: Reply | undefined;
      let printed = false;
      const current = this.s.router.current();
      emit({
        type: "status",
        model: current.label,
        location: this.s.where(),
        full: current !== this.s.router.bootstrap,
      });
      const spin = spinner("thinking");
      let tooLong = false;
      try {
        reply = await this.s.router.chat(await this.messages(), shape, {
          content: (t) => {
            if (!printed) {
              spin.stop();
              emit({ type: "assistant", phase: "start" });
            }
            printed = true;
            emit({ type: "assistant", phase: "delta", text: t });
          },
          reasoning: (t) => {
            if (Deno.env.get("AIBOOT_SHOW_THINKING")) say(t, "dim");
          },
        }, this.abort.signal);
      } catch (e) {
        if (this.abort.signal.aborted) {
          if (printed) emit({ type: "assistant", phase: "end" });
          say("[interrupted]", "dim");
          this.push({ role: "user", content: "(the user interrupted your last reply)" });
          return;
        }
        if (printed) emit({ type: "assistant", phase: "end" });
        if (isContextError(e) && compactions < 2) {
          tooLong = true;
        } else {
          say(`model error: ${(e as Error).message}`, "error");
          if (!(e instanceof LLMError)) throw e;
          return;
        }
      } finally {
        spin.stop();
        this.abort = null;
      }
      if (tooLong) {
        // Too long for the model: summarise the older turns and try again;
        // the second time, also clip long tool output in the turns kept.
        compactions++;
        const busy = spinner("compacting the conversation");
        let done: string | null = null;
        try {
          done = await this.compact();
        } finally {
          busy.stop();
        }
        if (!done || compactions === 2) {
          this.history = clipTools(this.history);
          done ??= "clipped long tool output to fit the context";
        }
        say(done, "dim");
        step--;
        continue;
      }
      if (!reply) return;
      if (printed) emit({ type: "assistant", phase: "end" });
      else if (reply.content) this.speak(reply.content);
      this.push({
        role: "assistant",
        content: reply.content,
        tool_calls: reply.toolCalls.length ? reply.toolCalls : undefined,
      });
      if (!reply.toolCalls.length) return;
      let replied = false;
      // Only what the answering model was offered (the base model is on rails).
      const offered = new Set(shape(this.s.router.current()).tools.map((t) => t.function.name));
      for (const [n, tc] of reply.toolCalls.entries()) {
        let result: string;
        if (!offered.has(tc.function.name)) {
          this.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `${tc.function.name} is not available to you. Your tools: ${
              [...offered].join(", ")
            }.`,
          });
          continue;
        }
        if (tc.function.name === "reply") {
          let msg = "";
          try {
            msg = String(JSON.parse(tc.function.arguments || "{}").message ?? "");
          } catch {
            msg = tc.function.arguments;
          }
          if (msg.trim()) this.speak(msg.trim());
          this.push({ role: "tool", tool_call_id: tc.id, content: "shown to the user" });
          replied = true;
          continue;
        }
        // ^C during a tool stops it (and everything it started) and ends the turn.
        const ac = this.abort = new AbortController();
        try {
          const args = tc.function.arguments.trim() ? JSON.parse(tc.function.arguments) : {};
          result = await this.s.exec(tc.function.name, args, ac.signal);
          if (ac.signal.aborted) {
            this.push({ role: "tool", tool_call_id: tc.id, content: result });
            for (const rest of reply.toolCalls.slice(n + 1)) {
              this.push({
                role: "tool",
                tool_call_id: rest.id,
                content: "not run: the user interrupted",
              });
            }
            this.push({ role: "user", content: "(the user stopped that command)" });
            say("[interrupted]", "dim");
            return;
          }
        } catch (e) {
          if (e instanceof Interrupted) {
            result = "interrupted by the user";
          } else if (e instanceof SyntaxError) {
            result = `error: arguments were not valid JSON: ${tc.function.arguments.slice(0, 200)}`;
          } else {
            result = `error: ${(e as Error).message}`;
          }
          if (!(e instanceof SyntaxError)) say(`  ${result}`, "error");
        } finally {
          this.abort = null;
        }
        this.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
      // reply hands the turn back to the user.
      if (replied) return;
    }
    warn(`stopped after ${MAX_STEPS} steps; say "continue" to go on`);
  }
}

const HELP = `commands:
  /where        current location (hop stack)
  /model        models in use
  /plan         show the plan
  /memory       show the memory INDEX
  /secrets      list remembered secrets (names only)
  /forget [k]   forget remembered secrets (all, or a location prefix)
  /sync         sync memory with its git repository
  /compact      summarise older turns to free context (keeps the last 2)
  /exit         leave the current remote host
  /quit         quit`;

export async function repl(agent: Agent): Promise<void> {
  const s = agent.s;
  if (s.fullFailure || currentTier(s.router) === "base" || (await s.memory.isEmpty())) {
    // The model speaks first: it reports a full model that failed to start, the
    // base model asks to set up a smarter one, and a new user is asked about
    // their hardware (docs/prompts).
    say(dim("(/help for commands)"));
    await agent.turn("(New session. Open as your instructions say.)");
  } else {
    say(`\n${bold("What would you like to do?")} ${dim("(/help for commands)")}`);
  }
  while (true) {
    let line: string | null;
    try {
      line = await ask(`${bold(s.where())}> `);
    } catch (e) {
      if (e instanceof Interrupted) break;
      throw e;
    }
    if (line === null) break;
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("/")) {
      const [cmd, ...rest] = t.split(/\s+/);
      switch (cmd) {
        case "/quit":
        case "/q":
          return;
        case "/help":
          say(HELP);
          break;
        case "/where":
          say(
            s.stack.map((l, i) => `${"  ".repeat(i)}${l.label}: ${describe(l.info)}`).join("\n"),
          );
          break;
        case "/model":
          say(
            `bootstrap: ${s.router.bootstrap.label} (${
              s.router.bootstrapUp()
                ? s.router.bootstrap.baseUrl
                : "stopped while the full model runs"
            })`,
          );
          say(
            `smart:     ${
              s.router.smart ? `${s.router.smart.label} (${s.router.smart.baseUrl})` : "none"
            }`,
          );
          say(`in use:    ${s.router.current().label}`);
          break;
        case "/plan":
          say(renderPlan(s.plan));
          break;
        case "/memory":
          say(await s.memory.index());
          break;
        case "/secrets":
          say(secrets.keys().join("\n") || "(none)");
          break;
        case "/forget":
          if (rest.length) say(`forgot ${secrets.forget(rest.join(" "))}`);
          else {
            secrets.clear();
            say("forgot everything");
          }
          break;
        case "/sync":
          try {
            say(await s.memory.sync());
          } catch (e) {
            say(red((e as Error).message));
          }
          break;
        case "/exit":
          say(await s.exec("ssh_exit", {}));
          break;
        case "/compact": {
          const busy = spinner("compacting the conversation");
          try {
            say((await agent.compact()) ?? "nothing to compact yet", "dim");
          } catch (e) {
            say(red((e as Error).message));
          } finally {
            busy.stop();
          }
          break;
        }
        default:
          say(HELP);
      }
      continue;
    }
    await agent.turn(t);
  }
}
