// The conversation loop: ask what the user wants, plan, then execute step
// by step with tools.

import type { Message, Reply } from "./llm.ts";
import { LLMError } from "./llm.ts";
import { describe, renderPlan, type Session, TOOLS } from "./tools.ts";
import { secrets } from "./secrets.ts";
import { ask, bold, cyan, dim, Interrupted, plain, red, warn, write } from "./ui.ts";

const MAX_STEPS = 60;

function systemPrompt(
  s: Session,
  index: string,
  docs: string[],
  memories: string[],
  extra: string,
  remote: string | null,
): string {
  const ep = s.router.current();
  const model = s.router.smart
    ? s.router.usingFallback()
      ? `You are the bootstrap model ${ep.label}, standing in because ${s.router.smart.label} is unavailable.`
      : `You are ${ep.label}. The bootstrap model ${s.router.bootstrap.label} is the fallback.`
    : `You are the bootstrap model ${ep.label}: small and limited. Your first job, unless the user wants something else, is to get a smarter hardware-accelerated model running and switch to it with use_model. Look at this machine's hardware (GPU, VRAM, unified memory, RAM) and suggest an intermediate model and server that fit; running it on this machine is recommended, otherwise on one of the machines the user wants to configure. Read the bundled docs first.`;
  return `You are ai-bootstrap, a terminal agent that sets up AI infrastructure (inference servers, models, GPU boxes, clusters) on the user's machines. ${model}

How you work:
1. Find out what the user wants. Ask short questions if the goal is unclear.
2. Before changing anything, inspect (OS, arch, GPUs, drivers, disk, what is already installed) and check memory and the docs.
3. Build a plan with the plan tool. For each step, think about what could go wrong (no GPU or wrong driver, unsupported OS/arch, not enough disk or RAM, port in use, no internet, missing permissions, a service already running) and note how you will detect and handle it.
4. Show the plan and get the user's agreement, then execute one step at a time: act, verify, update the plan. If a step fails, stop and re-plan rather than pushing on.
5. Read-only commands run immediately; everything else is shown to the user to approve. Use sudo for root and ssh to reach other machines; never type passwords or put sudo/ssh inside run.
6. Save durable facts about the user's setup (machines, GPUs, installed services, endpoints, preferences) to memory, and keep INDEX a short list of pointers. If memory is not synced to a private git repository (see Memory sync below), suggest setting that up once, so the setup can be maintained from other machines and recovered if this one is lost.
7. Be brief. Report results plainly.

Location: ${s.where()}
Operating system here: ${s.here.info.osName} on ${s.here.info.arch} (hardware-accelerated model options: docs/intermediate-${
    { darwin: "macos", windows: "windows" }[s.here.info.os] ?? "linux"
  })
Host details: ${describe(s.here.info)}
${s.here.info.shell === "powershell" ? "Commands here run in PowerShell.\n" : ""}
Bundled docs (memory_read docs/<name>): ${docs.join(", ") || "none"}
Memory files: ${memories.join(", ") || "none"}
Memory sync: ${remote ?? "not set up"}
${extra}
Memory INDEX:
${index.trim()}

Plan:
${s.plan.length ? plain(renderPlan(s.plan)) : "(none yet)"}`;
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

  constructor(readonly s: Session, private extraContext: () => string) {}

  /** Stops a model reply. False when no turn is running. */
  interrupt(): boolean {
    this.abort?.abort();
    return this.busy;
  }

  private async messages(): Promise<() => Message[]> {
    const index = await this.s.memory.index();
    const docs = await this.s.memory.docNames();
    const memories = await this.s.memory.list();
    const extra = this.extraContext();
    const remote = await this.s.memory.remote();
    return () => {
      const sys = systemPrompt(this.s, index, docs, memories, extra, remote);
      const budget = this.s.router.current().contextChars - sys.length;
      return [{ role: "system", content: sys }, ...fit(this.history, Math.max(budget, 4000))];
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
  console.log(`\n${bold("What would you like to do?")} ${dim("(/help for commands)")}`);
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
