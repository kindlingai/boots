// What the environment says about AI: the variables that point at models
// (URLs, model names) and the keys that unlock them, never the keys
// themselves. Each recognised provider comes with the exact use_model call
// that connects to it, so even the small base model can follow it.

/** An OpenAI-compatible provider: the key variable, its URL, a model to try. */
interface Provider {
  name: string;
  key: string;
  url: string;
  /** A variable naming the model, when the provider has a convention. */
  modelVar?: string;
  /** A sensible default when no model is named (check with models_at). */
  model?: string;
}

const PROVIDERS: Provider[] = [
  {
    name: "OpenRouter",
    key: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1",
    modelVar: "OPENROUTER_MODEL",
  },
  {
    name: "OpenAI",
    key: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1",
    modelVar: "OPENAI_MODEL",
    model: "gpt-4.1-mini",
  },
  { name: "Groq", key: "GROQ_API_KEY", url: "https://api.groq.com/openai/v1" },
  { name: "Together", key: "TOGETHER_API_KEY", url: "https://api.together.xyz/v1" },
  {
    name: "DeepSeek",
    key: "DEEPSEEK_API_KEY",
    url: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  { name: "Mistral", key: "MISTRAL_API_KEY", url: "https://api.mistral.ai/v1" },
  {
    name: "Fireworks",
    key: "FIREWORKS_API_KEY",
    url: "https://api.fireworks.ai/inference/v1",
  },
  {
    name: "Google Gemini (OpenAI-compatible)",
    key: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  {
    name: "Anthropic (OpenAI-compatible)",
    key: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1",
  },
  { name: "xAI", key: "XAI_API_KEY", url: "https://api.x.ai/v1" },
  { name: "Cerebras", key: "CEREBRAS_API_KEY", url: "https://api.cerebras.ai/v1" },
  { name: "Hugging Face", key: "HF_TOKEN", url: "https://router.huggingface.co/v1" },
];

/** Variables that may matter to which model ai-bootstrap uses. */
const SETTINGS = [
  "OPENAI_BASE_URL",
  "OPENAI_URL",
  "OPENAI_MODEL",
  "OPENROUTER_MODEL",
  "AIBOOT_TIER",
  "AIBOOT_BOOTSTRAP_MODEL",
  "AIBOOT_HOME",
  "OLLAMA_HOST",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
];

/** Names (only) of other variables that look like keys or endpoints. */
const LOOKS_LIKE = /(_API_KEY|_TOKEN|_SECRET|_BASE_URL|_API_BASE|_ENDPOINT)$/;

const call = (o: Record<string, unknown>) => `use_model ${JSON.stringify(o)}`;

/** Never the value of a key: whether it is set, and how long it is. */
function masked(v: string): string {
  return `set (${v.length} characters)`;
}

/**
 * The environment as the model should see it: settings with their values,
 * keys as set or not, and a ready use_model call for each provider found.
 */
export function describeEnvironment(env: Record<string, string> = Deno.env.toObject()): string {
  const out: string[] = [];
  const settings = SETTINGS.filter((k) => env[k]);
  out.push(
    settings.length
      ? `Settings:\n${settings.map((k) => `  ${k}=${env[k]}`).join("\n")}`
      : "Settings: none of OPENAI_BASE_URL, OPENAI_URL, OPENAI_MODEL, OPENROUTER_MODEL, AIBOOT_TIER are set.",
  );
  const recipes: string[] = [];
  const base = env.OPENAI_BASE_URL || env.OPENAI_URL;
  if (base) {
    // A server of the user's own (vLLM, SGLang, llama.cpp, mentat, a proxy).
    const o: Record<string, unknown> = {
      base_url: base.replace(/\/$/, ""),
      model: env.OPENAI_MODEL || "<an id from models_at>",
    };
    if (env.OPENAI_API_KEY) o.api_key_env = "OPENAI_API_KEY";
    recipes.push(
      `- OpenAI-compatible server at ${base}${
        env.OPENAI_MODEL ? "" : " (no OPENAI_MODEL: call models_at with this base_url for the id)"
      }:\n    ${call(o)}`,
    );
  }
  const keys: string[] = [];
  for (const p of PROVIDERS) {
    const v = env[p.key];
    if (!v) continue;
    keys.push(`  ${p.key}: ${masked(v)} (${p.name})`);
    // OPENAI_API_KEY with a base URL belongs to that server, recipe above.
    if (p.key === "OPENAI_API_KEY" && base) continue;
    const model = (p.modelVar && env[p.modelVar]) || p.model || "<an id from models_at>";
    recipes.push(
      `- ${p.name}:\n    ${call({ base_url: p.url, model, api_key_env: p.key })}${
        model.startsWith("<")
          ? `\n    (models_at ${p.url} with api_key_env ${p.key} lists the ids)`
          : ""
      }`,
    );
  }
  out.push(keys.length ? `Keys:\n${keys.join("\n")}` : "Keys: no known provider key is set.");
  const known = new Set([...SETTINGS, ...PROVIDERS.map((p) => p.key)]);
  const other = Object.keys(env).filter((k) => LOOKS_LIKE.test(k) && !known.has(k)).sort();
  if (other.length) {
    out.push(
      `Other variables that look like keys or endpoints (names only): ${other.join(", ")}. ` +
        "If one is an OpenAI-compatible provider's key, ask the user for its base URL, then use_model with api_key_env set to that name.",
    );
  }
  out.push(
    recipes.length
      ? `To connect (each asks the user; the key stays in the environment, by name):\n${
        recipes.join("\n")
      }`
      : "Nothing to connect to from the environment. If the user has a key, use_model with api_key (kept in memory only, never on disk) or ask_user_for_key; or ask them to restart ai-bootstrap with the key set (e.g. OPENROUTER_API_KEY=... ai-bootstrap), which also brings it back at every start.",
  );
  return out.join("\n\n");
}
