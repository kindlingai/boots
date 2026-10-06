// The conversation loop: ask what the user wants, plan, then execute step
// by step with tools.

import type { Message, Reply } from "./llm.ts";
import { LLMError } from "./llm.ts";
import { describe, renderPlan, type Session, TOOLS } from "./tools.ts";
import { currentTier, loadTemplates, systemPrompt, type Templates } from "./prompts.ts";
import { secrets } from "./secrets.ts";
import { ask, bold, cyan, dim, Interrupted, plain, red, warn, write } from "./ui.ts";

const MAX_STEPS = 60;

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

  /** Stops a model reply. False when no turn is running. */
  interrupt(): boolean {
    this.abort?.abort();
    return this.busy;
  }

  /** The system prompt as it stands now (it depends on which model is answering). */
  async system(): Promise<() => string> {
    this.templates ??= await loadTemplates();
    const t = this.templates;
    const [index, fleet, docs, memories, remote, fresh] = await Promise.all([
      this.s.memory.index(),
      this.s.memory.fleet(),
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
        docs,
        memories,
        memory_sync: remote,
        other_sources: extra,
        index,
        fleet,
        plan: this.s.plan.length ? plain(renderPlan(this.s.plan)) : "(none yet)",
        fresh,
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

  private async steps(userText: string): Promise<void> {
    this.history.push({ role: "user", content: userText });
    for (let step = 0; step < MAX_STEPS; step++) {
      this.abort = new AbortController();
      let reply: Reply;
      let printed = false;
      try {
        reply = await this.s.router.chat(await this.messages(), TOOLS, {
          content: (t) => {
            if (!printed) write(cyan("● "));
            printed = true;
            write(t);
          },
          reasoning: (t) => {
            if (Deno.env.get("AIBOOT_SHOW_THINKING")) write(dim(t));
          },
        }, this.abort.signal);
      } catch (e) {
        if (this.abort.signal.aborted) {
          console.log(dim("\n[interrupted]"));
          this.history.push({ role: "user", content: "(the user interrupted your last reply)" });
          return;
        }
        console.log(red(`\nmodel error: ${(e as Error).message}`));
        if (!(e instanceof LLMError)) throw e;
        return;
      } finally {
        this.abort = null;
      }
      if (printed) write("\n");
      else if (reply.content) console.log(`${cyan("●")} ${reply.content}`);
      this.history.push({
        role: "assistant",
        content: reply.content,
        tool_calls: reply.toolCalls.length ? reply.toolCalls : undefined,
      });
      if (!reply.toolCalls.length) return;
      for (const tc of reply.toolCalls) {
        let result: string;
        try {
          const args = tc.function.arguments.trim() ? JSON.parse(tc.function.arguments) : {};
          result = await this.s.exec(tc.function.name, args);
        } catch (e) {
          if (e instanceof Interrupted) {
            result = "interrupted by the user";
          } else if (e instanceof SyntaxError) {
            result = `error: arguments were not valid JSON: ${tc.function.arguments.slice(0, 200)}`;
          } else {
            result = `error: ${(e as Error).message}`;
          }
          if (!(e instanceof SyntaxError)) console.log(red(`  ${result}`));
        }
        this.history.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
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
  if (currentTier(s.router) === "base" || (await s.memory.isEmpty())) {
    // The model speaks first: the base model asks to set up a smarter one, and
    // a new user is asked about their hardware (docs/prompts).
    console.log(dim("(/help for commands)"));
    await agent.turn("(New session. Open as your instructions say.)");
  } else {
    console.log(`\n${bold("What would you like to do?")} ${dim("(/help for commands)")}`);
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
          console.log(HELP);
          break;
        case "/where":
          console.log(
            s.stack.map((l, i) => `${"  ".repeat(i)}${l.label}: ${describe(l.info)}`).join("\n"),
          );
          break;
        case "/model":
          console.log(`bootstrap: ${s.router.bootstrap.label} (${s.router.bootstrap.baseUrl})`);
          console.log(
            `smart:     ${
              s.router.smart ? `${s.router.smart.label} (${s.router.smart.baseUrl})` : "none"
            }`,
          );
          console.log(`in use:    ${s.router.current().label}`);
          break;
        case "/plan":
          console.log(renderPlan(s.plan));
          break;
        case "/memory":
          console.log(await s.memory.index());
          break;
        case "/secrets":
          console.log(secrets.keys().join("\n") || "(none)");
          break;
        case "/forget":
          if (rest.length) console.log(`forgot ${secrets.forget(rest.join(" "))}`);
          else {
            secrets.clear();
            console.log("forgot everything");
          }
          break;
        case "/sync":
          try {
            console.log(await s.memory.sync());
          } catch (e) {
            console.log(red((e as Error).message));
          }
          break;
        case "/exit":
          console.log(await s.exec("ssh_exit", {}));
          break;
        default:
          console.log(HELP);
      }
      continue;
    }
    await agent.turn(t);
  }
}
