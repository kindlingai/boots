// The conversation loop: ask what the user wants, plan, then execute step
// by step with tools.

import { languageRule } from "./platform.ts";
import type { Message, Reply } from "./llm.ts";
import { type ChatShape, type Endpoint, LLMError } from "./llm.ts";
import { BASE_TOOLS, describe, renderGoal, type Session, TOOLS } from "./tools.ts";
import { currentTier, loadTemplates, systemPrompt, type Templates, tierOf } from "./prompts.ts";
import { secrets } from "./secrets.ts";
import { ask, bold, dim, Interrupted, plain, red, say, spinner, warn } from "./ui.ts";
import { emit, EscInterrupted, setPrefill, takeSteering, tidy } from "./frontend.ts";
import { clipTools, compact, isContextError, SUMMARY_PROMPT } from "./compact.ts";
import { Backoff } from "./backoff.ts";
import { activeGoals, type Goal, normalizeGoals, parseGoals } from "./memory.ts";

/** A restart restores 6 turns, or as many as fill this share of the context. */
const RESTORE_SHARE = 0.3;

/** Progress updates: after this long without a word, over at most this many steps. */
const UPDATE_AFTER_MS = 60_000;
const UPDATE_STEPS = 8;
export const UPDATE_PROMPT =
  `You are watching an AI agent work on a user's machines (it sets up AI models and infrastructure). From its latest thinking, tool calls and their results, write 2 to 4 short sentences for the user, in the first person as the agent: what you are doing, what you have found, anything you are worried about (only if there is something), and where you are going next. Plain sentences: no preamble, no lists, no markdown.`;

/** update_status: how many model steps a status stays on screen, and how many stay in context. */
const STATUS_SHOWN_STEPS = 5;
const STATUS_KEEP = 4;

/** How often the model is reminded of its active goals. */
const REMIND_EVERY_TURNS = 3;
const REMIND_EVERY_TOOLS = 10;
/** A goal reminder appended to a message (not shown when turns are restored). */
const REMINDER = /\n\n\(Reminder: your active goals[\s\S]*$/;

/** Tool-call markup left in a reply: the call was malformed. */
const BROKEN_CALL = /<tool_call>|<function=|<\|tool_call/;

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
export function fit(history: Message[], budget: number, statuses: string[] = []): Message[] {
  const recent = 6;
  let msgs = history.map((m, i) =>
    m.role === "tool" && i < history.length - recent && m.content.length > 600
      ? {
        ...m,
        content: `${m.content.slice(0, 300)}\n...[older output cut]...\n${m.content.slice(-200)}`,
      }
      : m
  );
  // Measured as sent (JSON: quotes and newlines escaped, field names), so the
  // room left for the reply is room the server sees too.
  const size = (ms: Message[]) => ms.reduce((n, m) => n + JSON.stringify(m).length, 0);
  const lastUser = msgs.findLastIndex((m) => m.role === "user");
  if (lastUser > 0 && size(msgs) > budget) {
    // Drop from the front a step at a time (a message, with an assistant's
    // tool results), never the last user message or anything after it. A
    // long turn followed by "continue" then keeps its latest steps instead
    // of vanishing whole; when its start goes, a note says what it was for.
    const stepEnd = (i: number) => {
      let j = i + 1;
      if (msgs[i].role === "assistant") { while (j < lastUser && msgs[j].role === "tool") j++; }
      return j;
    };
    // Your latest update_status lines survive any drop: they say where you are.
    const anchor = statuses.length
      ? ` Your latest status updates, oldest first:\n${statuses.map((t) => `- ${t}`).join("\n")}`
      : "";
    const note = (asked: string | null) =>
      `(Earlier steps were dropped to fit the context; history_search can look through them.${
        asked === null
          ? ""
          : ` The work below began with the user asking: ${
            asked.length > 600 ? asked.slice(0, 600) + "…" : asked
          }`
      }${anchor})`;
    let from = 0;
    let asked: string | null = null;
    const withNote = (): Message[] => {
      const kept = msgs.slice(from);
      if (!from) return kept;
      // Part of a turn kept: say what it was for. A whole turn dropped needs
      // that only for the status anchor, folded into the next user message
      // (some templates insist that roles alternate).
      if (kept[0]?.role !== "user") return [{ role: "user", content: note(asked) }, ...kept];
      if (!anchor) return kept;
      return [{ ...kept[0], content: `${note(null)}\n\n${kept[0].content}` }, ...kept.slice(1)];
    };
    while (from < lastUser && size(withNote()) > budget) {
      if (msgs[from].role === "user") asked = msgs[from].content;
      from = stepEnd(from);
    }
    msgs = withNote();
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

/**
 * Characters kept free in the context for the reply (thinking included): a
 * quarter of the context, at most 32k tokens' worth.
 */
export function replyRoom(contextChars: number): number {
  return Math.min(Math.floor(contextChars / 4), 32_768 * 3);
}

/** How much of a cut-off thought to hand back (its end: the latest conclusions). */
const THOUGHT_KEPT = 4000;

/** "512 tokens", "3.4k tokens". */
export function tokenCount(n: number): string {
  return `${n < 1000 ? n : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`} token${
    n === 1 ? "" : "s"
  }`;
}

/** Text on one line, cut to `n` characters. */
function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export class Agent {
  history: Message[] = [];
  /** When the restored turns were last active, and where, if the history was restored. */
  restoredAt: string | null = null;
  restoredFrom: string | null = null;
  private abort: AbortController | null = null;
  private busy = false;
  /** Slows down tool calls that come in rapid succession. */
  private pace = new Backoff();

  private templates: Templates | null = null;

  constructor(readonly s: Session, private extraContext: () => string) {}

  /** Adds to the history and to the conversation log. */
  private push(m: Message): void {
    this.history.push(m);
    this.s.transcript?.append(m, this.s.where());
  }

  /** Picks up the last turns of the previous session from the log. */
  async restore(turns = 6, share = RESTORE_SHARE): Promise<number> {
    // The model that will do the work: the full one when set, else what answers now.
    const ctx = (this.s.router.smart ?? this.s.router.current()).contextChars;
    const r = await this.s.transcript?.restore(turns, Math.floor(ctx * share));
    if (!r) return 0;
    this.turnsSinceRestore = 0;
    this.history = r.messages;
    this.restoredAt = r.at;
    // Only a remote location matters: that connection did not survive the restart.
    this.restoredFrom = r.location && r.location.includes(">") ? r.location : null;
    return r.messages.filter((m) => m.role === "user").length;
  }

  private userTurns = 0;
  private toolCalls = 0;
  /** The model's latest update_status lines, with the step each came at. */
  private statuses: { text: string; step: number }[] = [];
  private stepCount = 0;
  private activityShown = false;

  /** Records an update_status and shows it. */
  private setStatus(text: string): void {
    const t = text.replace(/\s+/g, " ").trim().slice(0, 140);
    if (!t) return;
    this.statuses.push({ text: t, step: this.stepCount });
    if (this.statuses.length > STATUS_KEEP) this.statuses.shift();
    this.activityShown = true;
    emit({ type: "activity", text: t });
  }

  /** A status not renewed for STATUS_SHOWN_STEPS steps leaves the screen (not the context). */
  private expireStatus(): void {
    const last = this.statuses.at(-1);
    if (this.activityShown && (!last || this.stepCount - last.step >= STATUS_SHOWN_STEPS)) {
      this.activityShown = false;
      emit({ type: "activity", text: null });
    }
  }
  private goalTitles = "";

  /**
   * goals.json as the model should see it (finished goals inactive, the first
   * open one active when none is), and the active titles sent to the screen
   * when they change. Details stay with the model.
   */
  private noteGoals(stored: string): string {
    const goals = parseGoals(stored);
    if (!goals.length) {
      this.showGoals([]);
      return stored;
    }
    normalizeGoals(goals);
    this.showGoals(activeGoals(goals).map((g) => g.title));
    return JSON.stringify(goals, null, 2);
  }

  private showGoals(titles: string[]): void {
    const key = JSON.stringify(titles);
    if (key === this.goalTitles) return;
    this.goalTitles = key;
    emit({ type: "goals", titles });
  }

  /** A reminder of the active goals, with their details; "" when none is active. */
  private async goalReminder(): Promise<string> {
    const goals = parseGoals(await this.s.memory.goals());
    const active = activeGoals(normalizeGoals(goals));
    if (!active.length) return "";
    const lines = active.map((g) => `- ${g.title}${g.details ? `: ${g.details}` : ""}`);
    return `\n\n(Reminder: your active goals, from goals.json. Keep working toward them; mark one done, or move "active" to the next, as things progress.\n${
      lines.join("\n")
    })`;
  }

  /**
   * Messages the user sent while the model worked, added to the conversation
   * (after the latest tool results). True when there were any.
   */
  absorbSteering(): boolean {
    const notes = takeSteering();
    if (!notes.length) return false;
    this.push({
      role: "user",
      content: `(While you were working, the user wrote:)\n${
        notes.join("\n")
      }\n(Take it into account from here on.)`,
    });
    this.quietSince = Date.now();
    return true;
  }

  /** When the model last said something the user could read (or the turn began). */
  private quietSince = 0;
  /** The current turn's latest steps, for the progress updates. */
  private recent: { reasoning: string; said: string; calls: string[]; results: string[] }[] = [];
  /** What the user asked this turn. */
  private asked = "";
  /** Steps since the last progress update or visible words. */
  private stepsSinceUpdate = 0;

  /**
   * After a minute of working without a word to the user, and at least two
   * steps since the last update: the model, thinking off and with no tools,
   * sums up its recent steps in a few sentences, shown as an update and
   * kept as a status line (it survives trimming of the history).
   */
  private async maybeUpdate(): Promise<void> {
    if (Deno.env.get("AIBOOT_UPDATES") === "0") return;
    if (tierOf(this.s.router.current()) === "base") return;
    const after = Number(Deno.env.get("AIBOOT_UPDATE_AFTER_MS") ?? UPDATE_AFTER_MS);
    if (Date.now() - this.quietSince < after || this.stepsSinceUpdate < 2) return;
    this.stepsSinceUpdate = 0;
    const clip = (t: string, n: number) => t.length > n ? `…${t.slice(-n)}` : t;
    const log = this.recent.map((r, i) =>
      [
        `Step ${i + 1}:`,
        r.reasoning.trim() ? `Thinking: ${clip(r.reasoning.trim(), 1200)}` : "",
        r.said.trim() ? `Said: ${clip(r.said.trim(), 400)}` : "",
        ...r.calls.map((c, k) =>
          `Called: ${clip(c, 300)}\nResult: ${clip(plain(r.results[k] ?? "(still running)"), 500)}`
        ),
      ].filter(Boolean).join("\n")
    ).join("\n\n");
    const spin = spinner("writing an update");
    try {
      this.s.router.thinkingOffOnce = true;
      const r = await this.s.router.chat(
        () => [
          { role: "system", content: `${UPDATE_PROMPT}\n\n${languageRule()}` },
          {
            role: "user",
            content: `The user asked: ${
              clip(this.asked, 600)
            }\n\nThe agent's latest steps:\n\n${log}`,
          },
        ],
        [],
        {},
        AbortSignal.timeout(this.s.router.current().profile?.timeouts?.nonThinkingMs ?? 45_000),
      );
      const text = tidy(r.content.replace(/<think>[\s\S]*?<\/think>/g, ""));
      if (!text) return;
      this.speak(`◇ ${text}`);
      this.s.transcript?.append({ role: "system", content: `(progress update) ${text}` });
      // Kept with the status lines: an anchor that survives trimming.
      this.statuses.push({ text: clip(text, 300), step: this.stepCount });
      if (this.statuses.length > STATUS_KEEP) this.statuses.shift();
      this.quietSince = Date.now();
    } catch {
      // An update is a nicety: never in the way of the work.
    } finally {
      this.s.router.thinkingOffOnce = false;
      spin.stop();
    }
  }

  /** The restored turns, shown the way they looked: questions, replies, and the tools used. */
  async showRestored(): Promise<void> {
    for (const m of this.history) {
      if (m.role === "user") {
        const text = m.content.replace(REMINDER, "").trim();
        if (!/^\(.*\)$/s.test(text)) say(dim(`› ${oneLine(text, 200)}`));
      } else if (m.role === "assistant") {
        if (m.content.trim()) say(dim(`● ${oneLine(m.content, 300)}`));
        for (const c of m.tool_calls ?? []) {
          say(dim(`  ${c.function.name} ${oneLine(c.function.arguments, 120)}`));
        }
      }
    }
    // Where the work stood: the active goal and its steps (goals.json is kept across restarts).
    const g = activeGoals(normalizeGoals(parseGoals(await this.s.memory.goals()))).at(0);
    if (g) say(dim(plain(renderGoal(g))));
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
          () => [
            { role: "system", content: `${SUMMARY_PROMPT}\n\n${languageRule()}` },
            { role: "user", content: text },
          ],
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

  /** ^C during tools: this call's result, "not run" for the rest, and the turn ends. */
  /** The last turn ended because the user stopped it. */
  interrupted = false;

  private stopTurn(calls: { id: string }[], result: string): void {
    this.interrupted = true;
    const [first, ...rest] = calls;
    this.push({ role: "tool", tool_call_id: first.id, content: result });
    for (const r of rest) {
      this.push({ role: "tool", tool_call_id: r.id, content: "not run: the user interrupted" });
    }
    this.push({ role: "user", content: "(the user stopped that command)" });
    say("[interrupted]", "dim");
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
    const shownGoals = this.noteGoals(goals);
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
        scratch: this.s.here.info.scratch,
        hardware: this.s.here.info.hardware,
        docs,
        memories,
        memory_sync: remote,
        other_sources: extra,
        index,
        fleet,
        goals: shownGoals,
        fresh,
        failure: this.s.fullFailure,
        update: this.s.update,
        // The restored note is for picking up: the first two turns. Its "you are
        // local now" part holds only while that is so: once the model has
        // moved, it would tell it the wrong place.
        restored: this.restoredAt && this.turnsSinceRestore < 2
          ? {
            at: this.restoredAt,
            location: this.s.where() === "local" ? this.restoredFrom : null,
          }
          : null,
      });
  }

  private async messages(): Promise<() => Message[]> {
    const sys = await this.system();
    return () => {
      const content = sys();
      const ep = this.s.router.current();
      // The history gets what is left after the system prompt, the tool
      // definitions, and room for the reply: without that room, a long
      // session fills the context and the model runs out while thinking.
      const tools = JSON.stringify(shape(ep).tools).length;
      const budget = ep.contextChars - content.length - tools - replyRoom(ep.contextChars);
      return [
        { role: "system", content },
        ...fit(this.history, Math.max(budget, 4000), this.statuses.map((x) => x.text)),
      ];
    };
  }

  async turn(userText: string): Promise<void> {
    this.busy = true;
    this.interrupted = false;
    try {
      await this.steps(userText);
    } finally {
      this.busy = false;
      this.turnsSinceRestore++;
    }
  }

  /** Turns since the history was restored (the restored note fades after two). */
  private turnsSinceRestore = 0;

  /** A whole assistant message at once. */
  private speak(text: string): void {
    emit({ type: "assistant", phase: "start" });
    emit({ type: "assistant", phase: "delta", text });
    emit({ type: "assistant", phase: "end" });
  }

  private async steps(userText: string): Promise<void> {
    this.userTurns++;
    const remind = this.userTurns % REMIND_EVERY_TURNS === 0 ? await this.goalReminder() : "";
    this.push({ role: "user", content: userText + remind });
    let compactions = 0;
    let nudges = 0;
    this.quietSince = Date.now();
    this.recent = [];
    this.stepsSinceUpdate = 0;
    this.asked = userText;
    for (let step = 0; step < MAX_STEPS; step++) {
      this.stepCount++;
      this.expireStatus();
      await this.maybeUpdate();
      // What the user typed while the model worked: after the last tool results.
      if (step > 0) this.absorbSteering();
      this.abort = new AbortController();
      let reply: Reply | undefined;
      let printed = false;
      let lead = "";
      // What reached the screen as it streamed (text after a text-form tool
      // call does not: it is shown when the reply is complete).
      let streamed = "";
      const current = this.s.router.current();
      emit({
        type: "status",
        model: current.label,
        location: this.s.where(),
        full: current !== this.s.router.bootstrap,
      });
      const spin = spinner("thinking");
      // Tokens so far, next to "thinking", so a long think or tool call shows progress.
      let tokens = 0, shownAt = 0;
      let tooLong = false;
      try {
        reply = await this.s.router.chat(await this.messages(), shape, {
          token: () => {
            tokens++;
            const now = Date.now();
            if (!printed && now - shownAt >= 250) {
              shownAt = now;
              spin.note(tokenCount(tokens));
            }
          },
          content: (t) => {
            if (!printed) {
              // Whitespace before a tool call is not a reply: wait for words.
              lead += t;
              if (!lead.trim()) return;
              t = lead.trimStart();
              spin.stop();
              emit({ type: "assistant", phase: "start" });
            }
            printed = true;
            streamed += t;
            emit({ type: "assistant", phase: "delta", text: t });
          },
          reasoning: (t) => {
            if (Deno.env.get("AIBOOT_SHOW_THINKING")) say(t, "dim");
          },
        }, this.abort.signal);
      } catch (e) {
        if (this.abort.signal.aborted) {
          if (printed) emit({ type: "assistant", phase: "end" });
          this.interrupted = true;
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
      // A tool call we could not read, or nothing at all: say so and let the
      // model try again (twice), instead of ending the turn in silence.
      const broken = !reply.toolCalls.length && BROKEN_CALL.test(reply.content);
      const empty = !reply.toolCalls.length && !reply.content.trim();
      if (printed) {
        emit({ type: "assistant", phase: "end" });
        // Words after a tool call that did not stream (pre-, inter- and
        // post-tool text is all the user sees of the model's commentary).
        const said = streamed.trim(), all = reply.content.trim();
        if (!broken && all.length > said.length && all.startsWith(said)) {
          const rest = all.slice(said.length).trim();
          if (rest) this.speak(rest);
        }
      } else if (reply.content.trim() && !broken) this.speak(reply.content.trim());
      this.push({
        role: "assistant",
        content: reply.content,
        tool_calls: reply.toolCalls.length ? reply.toolCalls : undefined,
      });
      if (broken || empty) {
        // Out of output tokens with nothing said: it thought until the limit.
        // The next try answers without thinking.
        const thoughtOut = empty && reply.finish === "length";
        if (thoughtOut) this.s.router.thinkingOffOnce = true;
        const why = broken
          ? "a tool call that could not be read"
          : thoughtOut
          ? `an empty reply: it ${
            reply.reasoning ? `thought (${tokenCount(tokens)})` : "ran"
          } until it hit the output limit (${
            reply.maxTokens
              ? `${tokenCount(reply.maxTokens)} asked for`
              : "the server's own: the context had no room to ask for more"
          }); asking again with thinking off, handing back where its thinking got to`
          : "an empty reply";
        if (nudges < 2) {
          nudges++;
          say(
            thoughtOut ? `the model sent ${why}` : `the model sent ${why}; asking it to try again`,
            "dim",
          );
          this.push({
            role: "user",
            content: broken
              ? "(Your last tool call could not be parsed. Call the tool again through the tool-calling interface with valid JSON arguments, or answer in plain text.)"
              : thoughtOut && reply.reasoning.trim()
              ? `(You ran out of room while thinking, before you acted. The end of your thinking was:\n\n${
                reply.reasoning.trim().length > THOUGHT_KEPT ? "…" : ""
              }${
                reply.reasoning.trim().slice(-THOUGHT_KEPT)
              }\n\nAct on it now without thinking it over again: call the next tool, or answer the user.)`
              : "(Your last reply was empty. Continue: call a tool or answer the user.)",
          });
          continue;
        }
        say(`the model sent ${why} again; stopping here`, "warn");
        return;
      }
      // A reply that worked: only empty or broken ones in a row count.
      nudges = 0;
      // For the progress updates: what this step thought, said and called.
      this.stepsSinceUpdate++;
      if (reply.content.trim()) {
        this.quietSince = Date.now();
        this.stepsSinceUpdate = 0;
      }
      this.recent.push({
        reasoning: reply.reasoning,
        said: reply.content,
        calls: reply.toolCalls.map((c) => `${c.function.name}(${c.function.arguments})`),
        results: [],
      });
      if (this.recent.length > UPDATE_STEPS) this.recent.shift();
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
        if (tc.function.name === "update_status") {
          let text = "";
          try {
            text = String(JSON.parse(tc.function.arguments || "{}").status ?? "");
          } catch {
            text = tc.function.arguments;
          }
          this.setStatus(text);
          this.push({ role: "tool", tool_call_id: tc.id, content: "ok" });
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
        const wait = this.pace.next();
        if (wait) {
          const s = spinner(`pacing tool calls (${(wait / 1000).toFixed(1)}s)`);
          await new Promise<void>((ok) => {
            const t = setTimeout(ok, wait);
            ac.signal.addEventListener("abort", () => {
              clearTimeout(t);
              ok();
            });
          });
          s.stop();
        }
        try {
          const args = tc.function.arguments.trim() ? JSON.parse(tc.function.arguments) : {};
          // ^C while pacing: not run, and the turn ends below like any interrupt.
          result = ac.signal.aborted
            ? "not run: the user interrupted"
            : await this.s.exec(tc.function.name, args, ac.signal);
          if (ac.signal.aborted) {
            this.stopTurn(reply.toolCalls.slice(n), result);
            return;
          }
        } catch (e) {
          if (e instanceof Interrupted) {
            // ^C at a question the tool asked (run it?, a password): the turn
            // ends here, as it does for ^C while the command runs.
            this.stopTurn(reply.toolCalls.slice(n), "not run: the user pressed ^C at the prompt");
            return;
          } else if (e instanceof SyntaxError) {
            result = `error: arguments were not valid JSON: ${tc.function.arguments.slice(0, 200)}`;
          } else {
            result = `error: ${(e as Error).message}`;
          }
          if (!(e instanceof SyntaxError)) say(`  ${result}`, "error");
        } finally {
          this.abort = null;
          this.pace.done();
        }
        this.toolCalls++;
        if (this.toolCalls % REMIND_EVERY_TOOLS === 0) result += await this.goalReminder();
        this.push({ role: "tool", tool_call_id: tc.id, content: result });
        this.recent.at(-1)?.results.push(result);
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
  /plan         show the active goal and its steps
  /goals [clear|restore]  show the goals (titles); clear them all, or put
                back the last version that had goals
  /memory       show the memory INDEX
  /secrets      list remembered secrets (names only)
  /forget [k]   forget remembered secrets (all, or a location prefix)
  /sync         sync memory with its git repository
  /compact      summarise older turns to free context (keeps the last 2)
  /mode [auto|ask]  auto: run read-only commands and non-sudo writes without
                asking (never dangerous ones, never sudo, never on the base model)
  /probe        probe the model in use (30s at most): how it thinks, and the
                settings used for thinking and not thinking (cached; editable)
  /thinking [on|off]  off: ask models to answer without thinking first
                (faster, shallower); on: each model's default
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
    // Sent while the last turn was ending: that is the next turn. After a
    // stop, it goes back into the input box instead, to edit or send.
    const queued = takeSteering();
    if (queued.length && !agent.interrupted) {
      await agent.turn(queued.join("\n"));
      continue;
    }
    if (queued.length) setPrefill(queued.join(" "));
    try {
      line = await ask(`${bold(s.where())}${s.mode === "auto" ? dim(" [auto]") : ""}> `);
    } catch (e) {
      // Esc Esc at the main prompt does nothing; only ^C quits there.
      if (e instanceof EscInterrupted) continue;
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
        case "/mode": {
          const want = rest[0];
          if (want === "auto" || want === "ask") s.mode = want;
          else if (want) {
            say("usage: /mode [auto | ask]");
            break;
          }
          say(
            s.mode === "auto"
              ? `mode: auto. Read-only commands and writes that are not sudo run without asking; anything dangerous, anything the check could not judge, sudo, and other actions still ask.${
                currentTier(s.router) === "base"
                  ? ` ${
                    bold("Not while the small base model answers:")
                  } it still asks for everything.`
                  : ""
              } /mode ask turns it off.`
              : "mode: ask. Commands that change something ask first. /mode auto runs the safe ones without asking.",
          );
          break;
        }
        case "/goals": {
          const sub = rest[0];
          if (sub === "clear") {
            say(await s.memory.clearGoals(), "dim");
          } else if (sub === "restore") {
            const r = await s.memory.restoreGoals();
            say(
              r
                ? `restored ${r.titles.length} goal${
                  r.titles.length > 1 ? "s" : ""
                } from ${r.from}: ${r.titles.join("; ")}`
                : "no earlier goals to restore",
            );
          } else if (sub) {
            say("usage: /goals [clear | restore]");
            break;
          }
          {
            const goals = normalizeGoals(parseGoals(await s.memory.goals()));
            const line = (g: Goal, d: number): string[] => [
              `${"  ".repeat(d)}${g.done ? "✓" : g.active ? "◆" : "·"} ${g.title}`,
              ...(g.children ?? []).flatMap((c) => line(c, d + 1)),
            ];
            say(goals.length ? goals.flatMap((g) => line(g, 0)).join("\n") : "(no goals)");
          }
          break;
        }
        case "/probe": {
          // Probe the model in use again (its settings for thinking and not thinking).
          const p = await s.attachProfile(s.router.current(), true);
          if (!p) say("the small base model is not probed: its settings are fixed");
          break;
        }
        case "/thinking": {
          const want = rest[0];
          if (want === "off" || want === "on") s.router.thinkingOff = want === "off";
          else if (want) {
            say("usage: /thinking [on | off]");
            break;
          }
          const ep = s.router.current();
          say(
            s.router.thinkingOff
              ? `thinking: off. Models are asked not to think before answering (faster, shallower).${
                ep.noTemplateKwargs
                  ? ` ${ep.label} does not accept the setting, so it may still think.`
                  : ""
              } /thinking on turns it back on.`
              : "thinking: on (each model's default). /thinking off asks models to answer without thinking first.",
          );
          break;
        }
        case "/plan": {
          // The plan is the active goal's steps.
          const goals = normalizeGoals(parseGoals(await s.memory.goals()));
          const g = activeGoals(goals).find((x) => goals.includes(x)) ?? activeGoals(goals)[0];
          say(g ? renderGoal(g) : dim("  (no plan: no active goal)"));
          break;
        }
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
