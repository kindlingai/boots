// Finding AI that is already within reach: inference servers on this
// machine, and API keys in the environment.

import type { Endpoint } from "./llm.ts";

export interface Source {
  label: string;
  endpoint: Endpoint;
  /** Billions of parameters, guessed from the name. 0 when unknown. */
  sizeB: number;
  kind: "local" | "api";
}

export const LOCAL_PORTS: Record<number, string> = {
  11434: "Ollama",
  8080: "llama.cpp",
  8000: "vLLM",
  30000: "SGLang",
  1234: "LM Studio",
  4000: "LiteLLM",
  5000: "text-generation-webui",
  5001: "KoboldCpp",
  8081: "llama.cpp",
  18080: "ai-bootstrap llama.cpp",
  6381: "mentat router",
};

/** "qwen3:4b" 4, "Qwen3-30B-A3B" 30, "mixtral-8x7b" 56, "smol-360m" 0.36. */
export function sizeFromName(name: string): number {
  const s = name.toLowerCase();
  const moe = s.match(/(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  let best = 0;
  for (const m of s.matchAll(/(?<![a-z0-9.x])(\d+(?:\.\d+)?)b(?![a-z])/g)) {
    best = Math.max(best, Number(m[1]));
  }
  if (!best) {
    for (const m of s.matchAll(/(?<![a-z0-9.])(\d+)m(?![a-z])/g)) {
      best = Math.max(best, Number(m[1]) / 1000);
    }
  }
  return best;
}

export function contextFor(sizeB: number, api: boolean): number {
  if (api || sizeB >= 30) return 400_000;
  if (sizeB >= 7) return 80_000;
  return 40_000;
}

async function probe(host: string, port: number, service: string): Promise<Source[]> {
  const base = `http://${host}:${port}/v1`;
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) {
      await r.body?.cancel();
      return [];
    }
    const j = await r.json();
    const ids: string[] = (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name ?? m.model)
      .filter(Boolean);
    return ids.map((id) => {
      const sizeB = sizeFromName(id);
      return {
        label: `${service} on :${port} — ${id}`,
        kind: "local" as const,
        sizeB,
        endpoint: {
          label: `${id} (${service})`,
          baseUrl: base,
          model: id,
          contextChars: contextFor(sizeB, false),
        },
      };
    });
  } catch {
    return [];
  }
}

/** Probes common ports on these hosts in parallel; largest models first. */
export async function scanLocal(hosts = ["127.0.0.1"], ports = LOCAL_PORTS): Promise<Source[]> {
  const jobs: Promise<Source[]>[] = [];
  for (const h of hosts) {
    for (const [p, svc] of Object.entries(ports)) jobs.push(probe(h, Number(p), svc));
  }
  const all = (await Promise.all(jobs)).flat();
  const seen = new Set<string>();
  return all
    .filter((s) =>
      !seen.has(s.endpoint.baseUrl + s.endpoint.model) &&
      seen.add(s.endpoint.baseUrl + s.endpoint.model)
    )
    .sort((a, b) => b.sizeB - a.sizeB);
}

const OPENROUTER = "https://openrouter.ai/api/v1";

/**
 * The best free OpenRouter model that supports tool calls, by context length
 * and size. Free model ids change often, so this asks rather than pinning.
 */
export async function freeOpenRouterModel(): Promise<string | null> {
  try {
    const r = await fetch(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    const models: any[] = (await r.json()).data ?? [];
    const free = models.filter((m) =>
      (String(m.id).endsWith(":free") ||
        (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0)) &&
      (m.supported_parameters ?? []).includes("tools")
    );
    free.sort((a, b) =>
      (sizeFromName(b.id) - sizeFromName(a.id)) ||
      ((b.context_length ?? 0) - (a.context_length ?? 0))
    );
    return free[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Hosted models reachable through keys in the environment. */
export async function scanApiKeys(): Promise<Source[]> {
  const out: Source[] = [];
  if (Deno.env.get("OPENROUTER_API_KEY")) {
    const chosen = Deno.env.get("OPENROUTER_MODEL") ?? (await freeOpenRouterModel());
    const model = chosen ?? "openrouter/auto";
    out.push({
      label: `OpenRouter (OPENROUTER_API_KEY) — ${model}${
        chosen ? "" : " (no free model found; may cost credits)"
      }`,
      kind: "api",
      sizeB: sizeFromName(model),
      endpoint: {
        label: `${model} (OpenRouter)`,
        baseUrl: OPENROUTER,
        model,
        keyEnv: "OPENROUTER_API_KEY",
        contextChars: contextFor(0, true),
      },
    });
  }
  const base = Deno.env.get("OPENAI_BASE_URL");
  if (Deno.env.get("OPENAI_API_KEY") || base) {
    const model = Deno.env.get("OPENAI_MODEL") ?? (base ? "default" : "gpt-4.1-mini");
    const url = (base ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const hosted = !base || url.includes("api.openai.com");
    out.push({
      label: `${hosted ? "OpenAI" : "OpenAI-compatible"} (${
        base ? "OPENAI_BASE_URL" : "OPENAI_API_KEY"
      }) — ${model} at ${url}`,
      kind: "api",
      sizeB: sizeFromName(model),
      endpoint: {
        label: model,
        baseUrl: url,
        model,
        keyEnv: Deno.env.get("OPENAI_API_KEY") ? "OPENAI_API_KEY" : undefined,
        contextChars: contextFor(sizeFromName(model), hosted),
      },
    });
  }
  return out;
}
