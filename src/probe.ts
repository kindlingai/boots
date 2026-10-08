// Probing a model endpoint for how it thinks: a handful of small requests,
// 30 seconds at most in all, to learn whether it thinks before answering,
// how to turn that off, which reasoning levels it takes, and how long each
// takes. From that, two settings: "thinking" (the cheapest that thinks,
// answers a small reasoning task correctly and does not think for long) and
// "non-thinking" (thinking off, for quick side requests and retries). The
// result is cached per endpoint and model as JSON the user can edit, and
// /probe (or the probe_model tool) runs it again.

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { ALWAYS_THINKS, type Endpoint, listedEfforts } from "./llm.ts";
import { dataDir, ensureDir } from "./platform.ts";

/** Request parameters for one way of asking (merged into the request body). */
export type Params = Record<string, unknown>;

export interface Trial {
  name: string;
  params: Params;
  /** The server took the parameters (no 4xx). */
  accepted: boolean;
  error?: string;
  latencyMs: number;
  /** Whether it thought (reasoning text, or a <think> block). */
  thought: boolean;
  /** Thinking tokens (from usage, or estimated from the text). */
  reasoningTokens: number;
  answer: string;
  correct: boolean;
}

export interface ModelProfile {
  endpoint: string;
  model: string;
  probedAt: string;
  /** How long the probe took. */
  probeMs: number;
  features: {
    /** Thinks by default. */
    thinksByDefault: boolean;
    /** chat_template_kwargs turns thinking off. */
    templateKwargsOff: boolean;
    /** Takes reasoning_effort (top level or in chat_template_kwargs). */
    reasoningEffort: "top-level" | "template" | null;
    /** max_tokens is honoured. */
    maxTokens: boolean;
    /** It always thinks: turning thinking off is refused or ignored. */
    alwaysThinks?: boolean;
    /** The reasoning levels the server takes, when a refusal listed them. */
    efforts?: string[];
  };
  /** Used for normal requests. */
  thinking: { params: Params; latencyMs: number; reasoningTokens: number; correct: boolean };
  /** Used wherever thinking is turned off (side requests, retries, /thinking off). */
  nonThinking: { params: Params; latencyMs: number; correct: boolean };
  /** Suggested request timeouts, from the measured speed. */
  timeouts: { thinkingMs: number; nonThinkingMs: number };
  trials: Trial[];
}

/** The whole probe stops after this long. */
export const PROBE_BUDGET_MS = 30_000;
/** One request gives up after this long. */
const TRIAL_MS = 10_000;
/** A thinking setting that takes longer than this on the test is too slow. */
const THINK_BUDGET_MS = 10_000;

/** A small task that needs a moment of reasoning, with an answer to check. */
const TASK =
  "A train leaves at 3:40 pm and the trip takes 2 hours 35 minutes. When does it arrive? Answer with the time only.";
const CORRECT = /\b(6:15|18:15)\b/;

const OFF = { chat_template_kwargs: { enable_thinking: false, thinking: false } };

/** Where a profile is cached: one file per endpoint and model. */
export async function profilePath(ep: Pick<Endpoint, "baseUrl" | "model">): Promise<string> {
  const h = encodeHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ep.baseUrl}\0${ep.model}`)),
    ),
  ).slice(0, 16);
  const slug = ep.model.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40);
  return join(dataDir(), "probes", `${slug}-${h}.json`);
}

export async function loadProfile(ep: Endpoint): Promise<ModelProfile | null> {
  try {
    const p = JSON.parse(await Deno.readTextFile(await profilePath(ep)));
    return p && p.thinking && p.nonThinking ? p : null;
  } catch {
    return null;
  }
}

export async function saveProfile(p: ModelProfile): Promise<string> {
  const path = await profilePath({ baseUrl: p.endpoint, model: p.model });
  await ensureDir(join(dataDir(), "probes"));
  await Deno.writeTextFile(path, JSON.stringify(p, null, 2) + "\n");
  return path;
}

/** The key the endpoint's server wants, if any. */
type KeyOf = (ep: Endpoint) => string | undefined;

async function trial(
  ep: Endpoint,
  key: string | undefined,
  name: string,
  params: Params,
  until: number,
  maxTokens = 2048,
): Promise<Trial> {
  const t0 = Date.now();
  const left = Math.min(TRIAL_MS, until - t0);
  const base: Trial = {
    name,
    params,
    accepted: false,
    latencyMs: 0,
    thought: false,
    reasoningTokens: 0,
    answer: "",
    correct: false,
  };
  if (left < 1000) return { ...base, error: "out of probe time" };
  try {
    const r = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: ep.model,
        messages: [{ role: "user", content: TASK }],
        max_tokens: maxTokens,
        stream: false,
        ...params,
      }),
      signal: AbortSignal.timeout(left),
    });
    const latencyMs = Date.now() - t0;
    if (!r.ok) {
      const text = (await r.text()).slice(0, 200);
      return { ...base, latencyMs, error: `HTTP ${r.status}: ${text}` };
    }
    const j = await r.json();
    const m = j.choices?.[0]?.message ?? {};
    let content = String(m.content ?? "");
    let reasoning = String(m.reasoning_content ?? m.reasoning ?? "");
    const think = content.match(/<think>([\s\S]*?)(<\/think>|$)/);
    if (think) {
      reasoning += think[1];
      content = content.replace(/<think>[\s\S]*?(<\/think>|$)/, "");
    }
    const usage = j.usage?.completion_tokens_details?.reasoning_tokens;
    const reasoningTokens = typeof usage === "number" && usage > 0
      ? usage
      : Math.round(reasoning.length / 4);
    const answer = content.trim().slice(0, 200);
    return {
      ...base,
      accepted: true,
      latencyMs,
      thought: reasoning.trim().length > 0 || reasoningTokens > 0,
      reasoningTokens,
      answer,
      correct: CORRECT.test(answer),
    };
  } catch (e) {
    return { ...base, latencyMs: Date.now() - t0, error: (e as Error).message.slice(0, 200) };
  }
}

/**
 * Probes `ep` within PROBE_BUDGET_MS. Never throws: a server that answers
 * nothing gives a profile that changes nothing (empty parameters).
 */
export async function probe(
  ep: Endpoint,
  keyOf: KeyOf,
  log: (s: string) => void = () => {},
  budgetMs = PROBE_BUDGET_MS,
): Promise<ModelProfile> {
  const start = Date.now();
  const until = start + budgetMs;
  const key = keyOf(ep);
  const trials: Trial[] = [];
  const run = async (name: string, params: Params, maxTokens?: number) => {
    const t = await trial(ep, key, name, params, until, maxTokens);
    trials.push(t);
    log(
      `${name}: ${
        t.accepted
          ? `${(t.latencyMs / 1000).toFixed(1)}s, ${
            t.thought ? `thought ~${t.reasoningTokens} tokens` : "no thinking"
          }, ${t.correct ? "right" : "wrong"}`
          : `not taken (${t.error})`
      }`,
    );
    return t;
  };

  const def = await run("default", {});
  const off = await run("thinking off", OFF);
  // Reasoning levels, in the two forms servers take them.
  const efforts: Trial[] = [];
  let form: "top-level" | "template" | null = null;
  let allowed: string[] | null = null;
  if (def.thought) {
    const low = await run("effort low", { reasoning_effort: "low" });
    if (low.accepted && low.reasoningTokens < def.reasoningTokens * 0.8) form = "top-level";
    efforts.push(low);
    if (!form) {
      const lowT = await run("effort low (template)", {
        chat_template_kwargs: { reasoning_effort: "low" },
      });
      efforts.push(lowT);
      if (lowT.accepted && lowT.reasoningTokens < def.reasoningTokens * 0.8) form = "template";
    }
    if (form) {
      const level = (e: string) =>
        form === "top-level"
          ? { reasoning_effort: e }
          : { chat_template_kwargs: { reasoning_effort: e } };
      const medium = await run("effort medium", level("medium"));
      efforts.push(medium);
      // Refused with the levels it takes ("please use low, high, or max"):
      // the next one up from medium instead.
      allowed = listedEfforts(medium.error ?? "");
      const next = allowed?.find((e) => ["high", "xhigh", "max"].includes(e));
      if (!medium.accepted && next) efforts.push(await run(`effort ${next}`, level(next)));
    }
  }
  const tiny = await run("max_tokens 8", OFF, 8);

  const offWorks = off.accepted && !off.thought && def.thought;
  // Always thinks: asking it not to is refused, or it thinks anyway.
  const alwaysThinks = def.thought && !offWorks &&
    (off.accepted || ALWAYS_THINKS.test(off.error ?? "") ||
      trials.some((t) => ALWAYS_THINKS.test(t.error ?? "")));

  // Thinking: the cheapest that thinks, answers right and is quick enough;
  // else the quickest right one; else the default.
  const thinkers = [...efforts, def].filter((t) => t.accepted && t.thought);
  const good = thinkers.filter((t) => t.correct && t.latencyMs <= THINK_BUDGET_MS)
    .sort((a, b) => a.reasoningTokens - b.reasoningTokens);
  const right = thinkers.filter((t) => t.correct).sort((a, b) => a.latencyMs - b.latencyMs);
  const pick = good[0] ?? right[0] ?? (def.accepted ? def : null);
  // Non-thinking: thinking off where it works; else the lightest thinker.
  // One that always thinks: its lightest level, or as it is.
  const quiet: Trial | null = offWorks ? off : efforts.filter((t) => t.accepted)
    .sort((a, b) => a.reasoningTokens - b.reasoningTokens)[0] ?? (alwaysThinks ? null : off);

  const profile: ModelProfile = {
    endpoint: ep.baseUrl,
    model: ep.model,
    probedAt: new Date().toISOString(),
    probeMs: Date.now() - start,
    features: {
      thinksByDefault: def.thought,
      templateKwargsOff: offWorks,
      reasoningEffort: form,
      maxTokens: tiny.accepted && tiny.answer.length < 60,
      ...(alwaysThinks ? { alwaysThinks } : {}),
      ...(allowed ? { efforts: allowed } : {}),
    },
    thinking: {
      params: pick ? pick.params : {},
      latencyMs: pick?.latencyMs ?? 0,
      reasoningTokens: pick?.reasoningTokens ?? 0,
      correct: pick?.correct ?? false,
    },
    nonThinking: {
      params: quiet?.accepted ? quiet.params : {},
      latencyMs: quiet?.latencyMs ?? def.latencyMs,
      correct: quiet?.correct ?? def.correct,
    },
    // Generous, from what was measured: a real request is longer than the test.
    timeouts: {
      thinkingMs: Math.max(120_000, (pick?.latencyMs ?? 0) * 20),
      nonThinkingMs: Math.max(30_000, (quiet?.latencyMs ?? def.latencyMs) * 10),
    },
    trials,
  };
  return profile;
}

/** One line for the user: what was chosen. */
export function describeProfile(p: ModelProfile): string {
  const show = (x: Params) => Object.keys(x).length ? JSON.stringify(x) : "(the server's default)";
  return `${p.model}: thinking ${
    show(p.thinking.params)
  } (~${p.thinking.reasoningTokens} thinking tokens, ${
    (p.thinking.latencyMs / 1000).toFixed(1)
  }s on the test${p.thinking.correct ? "" : ", answer wrong"}); non-thinking ${
    show(p.nonThinking.params)
  } (${(p.nonThinking.latencyMs / 1000).toFixed(1)}s)${
    p.features?.alwaysThinks ? "; it always thinks (cannot be turned off)" : ""
  }${
    p.features?.efforts?.length ? `; reasoning levels ${p.features.efforts.join("/")}` : ""
  }; probed in ${(p.probeMs / 1000).toFixed(1)}s`;
}

/** Puts a profile's settings on the endpoint; returns the profile. */
export function applyProfile(ep: Endpoint, p: ModelProfile): ModelProfile {
  if (p.features?.alwaysThinks) ep.alwaysThinks = true;
  if (p.features?.efforts?.length) ep.efforts = p.features.efforts;
  ep.profile = {
    thinking: p.thinking?.params ?? {},
    nonThinking: p.nonThinking?.params ?? {},
    timeouts: p.timeouts,
  };
  return p;
}
