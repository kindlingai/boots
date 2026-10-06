// The conversation loop: ask what the user wants, plan, then execute step
// by step with tools.

import type { Message, Reply } from "./llm.ts";
import { type ChatShape, type Endpoint, LLMError } from "./llm.ts";
import { BASE_TOOLS, describe, renderPlan, type Session, TOOLS } from "./tools.ts";
import { currentTier, loadTemplates, systemPrompt, type Templates, tierOf } from "./prompts.ts";
import { secrets } from "./secrets.ts";
import { ask, bold, dim, Interrupted, plain, red, say, spinner, warn } from "./ui.ts";
import { emit } from "./frontend.ts";

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

/** Fits the history into the current model's budget. */
function fit(history: Message[], budget: number): Message[] {
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
  while (size(msgs) > budget && msgs.length > 1) {
    // Drop the oldest exchange, keeping the history starting at a user turn.
    msgs = msgs.slice(1);
    while (msgs.length > 1 && msgs[0].role !== "user") msgs = msgs.slice(1);
  }
  return msgs;
}

export class Agent {
  history: Message[] = [];
  private abort: AbortController | null = null;
  private busy = false;

  private templates: Templates | null = null;

  constructor(readonly s: Session, private extraContext: () => string) {}

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
    this.history.push({ role: "user", content: userText });
    for (let step = 0; step < MAX_STEPS; step++) {
      this.abort = new AbortController();
      let reply: Reply;
      let printed = false;
      const current = this.s.router.current();
      emit({
        type: "status",
        model: current.label,
        location: this.s.where(),
        full: current !== this.s.router.bootstrap,
      });
      const spin = spinner("thinking");
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
          this.history.push({ role: "user", content: "(the user interrupted your last reply)" });
          return;
        }
        if (printed) emit({ type: "assistant", phase: "end" });
        say(`model error: ${(e as Error).message}`, "error");
        if (!(e instanceof LLMError)) throw e;
        return;
      } finally {
        spin.stop();
        this.abort = null;
      }
      if (printed) emit({ type: "assistant", phase: "end" });
      else if (reply.content) this.speak(reply.content);
      this.history.push({
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
          this.history.push({
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
          this.history.push({ role: "tool", tool_call_id: tc.id, content: "shown to the user" });
          replied = true;
          continue;
        }
        // ^C during a tool stops it (and everything it started) and ends the turn.
        const ac = this.abort = new AbortController();
        try {
          const args = tc.function.arguments.trim() ? JSON.parse(tc.function.arguments) : {};
          result = await this.s.exec(tc.function.name, args, ac.signal);
          if (ac.signal.aborted) {
            this.history.push({ role: "tool", tool_call_id: tc.id, content: result });
            for (const rest of reply.toolCalls.slice(n + 1)) {
              this.history.push({
                role: "tool",
                tool_call_id: rest.id,
                content: "not run: the user interrupted",
              });
            }
            this.history.push({ role: "user", content: "(the user stopped that command)" });
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
        this.history.push({ role: "tool", tool_call_id: tc.id, content: result });
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
        default:
          say(HELP);
      }
      continue;
    }
    await agent.turn(t);
  }
}
