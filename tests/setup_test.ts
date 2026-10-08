import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { describeEnvironment } from "../src/envinfo.ts";
import { loadSetup, offerOffline, type SetupDeps } from "../src/setup.ts";

Deno.test("environment: settings and keys (never their values), with a use_model call for each", () => {
  const out = describeEnvironment({
    OPENROUTER_API_KEY: "sk-or-secret-123",
    OPENROUTER_MODEL: "z-ai/glm-5.3",
    GROQ_API_KEY: "gsk_secret_456",
    OPENAI_BASE_URL: "http://10.0.0.70:6381/v1/",
    MY_LAB_TOKEN: "lab-secret",
    PATH: "/usr/bin",
  });
  for (const secret of ["sk-or-secret-123", "gsk_secret_456", "lab-secret"]) {
    assert(!out.includes(secret), `no key value: ${secret}`);
  }
  assertStringIncludes(out, "OPENAI_BASE_URL=http://10.0.0.70:6381/v1/");
  assertStringIncludes(out, "OPENROUTER_API_KEY: set (16 characters)");
  assertStringIncludes(
    out,
    'use_model {"base_url":"https://openrouter.ai/api/v1","model":"z-ai/glm-5.3","api_key_env":"OPENROUTER_API_KEY"}',
  );
  assertStringIncludes(out, '"base_url":"https://api.groq.com/openai/v1"');
  assertStringIncludes(out, 'use_model {"base_url":"http://10.0.0.70:6381/v1"');
  assertStringIncludes(out, "models_at");
  assertStringIncludes(out, "MY_LAB_TOKEN");
  assert(!out.includes("PATH"));
  // Nothing set: how to give a key.
  assertStringIncludes(describeEnvironment({}), "api_key (kept in memory only");
});

Deno.test("offline setup: asked once; no leaves it unconfigured; /setup asks again and sets it up", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("AIBOOT_HOME", dir);
  try {
    const asked: string[] = [];
    let answer = false;
    let installed = 0;
    const d: SetupDeps = {
      ask: (p) => {
        asked.push(p);
        return Promise.resolve(answer);
      },
      installBase: () => {
        installed++;
        return Promise.resolve();
      },
      baseInstalled: () => Promise.resolve(installed > 0),
      fullScript: () => Promise.resolve(false),
    };
    assertEquals(await offerOffline("glm-5.3", false, d), null, "no: nothing to set up");
    assertEquals(asked.length, 1);
    assertEquals((await loadSetup())?.offline, false);
    assertEquals(installed, 0, "no: nothing installed");
    assertEquals(await offerOffline("glm-5.3", false, d), null);
    assertEquals(asked.length, 1, "not asked again at the next start");
    // /setup: asked again; yes installs the base model and hands the full one to the model.
    answer = true;
    const note = await offerOffline("glm-5.3", true, d);
    assertEquals(asked.length, 2);
    assertEquals(installed, 1);
    assertEquals((await loadSetup())?.offline, true);
    assertStringIncludes(note!, "set_up_model");
    assertStringIncludes(note!, "go back to glm-5.3");
    // With a full local model already set up, nothing is left for the model.
    d.fullScript = () => Promise.resolve(true);
    assertEquals(await offerOffline("glm-5.3", true, d), null);
    assertEquals(installed, 1, "the base model is not installed twice");
  } finally {
    Deno.env.delete("AIBOOT_HOME");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("use_model takes a key in memory only; saved_models lists, updates and forgets", async () => {
  const { Router } = await import("../src/llm.ts");
  const { Memory } = await import("../src/memory.ts");
  const { McpManager } = await import("../src/mcp.ts");
  const { Session, loadSmart } = await import("../src/tools.ts");
  const { secrets } = await import("../src/secrets.ts");
  const dir = await Deno.makeTempDir();
  Deno.env.set("AIBOOT_HOME", dir);
  const auth: string[] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    auth.push(req.headers.get("authorization") ?? "");
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [] });
    return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  });
  const url = `http://127.0.0.1:${server.addr.port}/v1`;
  try {
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
      new Memory(`${dir}/mem`),
      new McpManager(`${dir}/mcp.json`),
      () => Promise.resolve(null),
    );
    await s.init();
    (s as any).skipPermissions = true;
    const r = await s.exec("use_model", { base_url: url, model: "glm", api_key: "sk-given-789" });
    assertStringIncludes(r, "switched to glm");
    assert(auth.includes("Bearer sk-given-789"), "the key was used");
    assertEquals(secrets.get([url], "apikey"), "sk-given-789");
    const file = await Deno.readTextFile(`${dir}/models.json`).catch(() => "");
    const saved = await loadSmart();
    assert(
      !JSON.stringify(saved).includes("sk-given-789") && !file.includes("sk-given"),
      "never on disk",
    );
    assertEquals(saved[0].keyInMemory, true);
    // A key variable that is not set: said so, not switched.
    assertStringIncludes(
      await s.exec("use_model", { base_url: url, model: "x", api_key_env: "NO_SUCH_KEY_VAR" }),
      "not set",
    );
    assertStringIncludes(await s.exec("saved_models", { action: "list" }), "1. glm: glm at");
    const up = await s.exec("saved_models", {
      action: "update",
      index: 1,
      set: { sampling: { temperature: 0.6 }, context_tokens: 32768, label: "GLM" },
    });
    assertStringIncludes(up, 'sampling {"temperature":0.6}');
    assertStringIncludes(up, "context 32768 tokens");
    assertEquals(s.router.smart?.label, "GLM", "the one in use takes the change");
    assertStringIncludes(
      await s.exec("saved_models", { action: "update", index: 1, set: { nope: 1 } }),
      "cannot set nope",
    );
    assertStringIncludes(
      await s.exec("saved_models", { action: "remove", index: 1 }),
      "no saved model connections",
    );
    assertEquals((await loadSmart()).length, 0);
  } finally {
    Deno.env.delete("AIBOOT_HOME");
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
