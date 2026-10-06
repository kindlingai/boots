// ai-bootstrap: a minimal agent harness that bootstraps AI infrastructure.
//
//   ai-bootstrap              interactive session
//   ai-bootstrap --far        far agent (started by ai-bootstrap over ssh)
//   ai-bootstrap --version

import { checkForUpdate } from "./update.ts";
import { askpassMain } from "./askpass.ts";
import { farMain } from "./far.ts";
import { jsonEvalMain } from "./jsoneval.ts";
import { Memory } from "./memory.ts";
import { McpManager } from "./mcp.ts";
import { type BootstrapControl, Router } from "./llm.ts";
import { makeNearAsker } from "./secrets.ts";
import { loadSmart, restoreSmart, saveSmart, Session } from "./tools.ts";
import { type FullFailure, gpuOffload, logPath, scriptPath, startFull } from "./intelligence.ts";
import { startLlama } from "./llama.ts";
import { downloadSize } from "./rails.ts";
import { Agent, repl } from "./agent.ts";
import { boot } from "./boot.ts";
import {
  cacheDir,
  currentTarget,
  dataDir,
  exists,
  modelsDir,
  scriptsDir,
  VERSION,
} from "./platform.ts";
import { bold, dim, info, red, say, warn } from "./ui.ts";
import { emit, frontend, setFrontend } from "./frontend.ts";
import { TuiFrontend } from "./frontends/tui.ts";

async function interactive(tui: boolean): Promise<number> {
  // ^C at the TUI's input arrives as a key, not a signal: it goes through here too.
  let onInterrupt = () => {};
  if (tui) {
    if (Deno.stdin.isTerminal() && Deno.stdout.isTerminal()) {
      const f = new TuiFrontend({
        title: `ai-bootstrap ${VERSION}`,
        onInterrupt: () => onInterrupt(),
      });
      setFrontend(f);
      f.start();
    } else warn("--tui needs a terminal; using the line interface");
  }
  say(`${bold("ai-bootstrap")} ${VERSION} ${dim(`(${currentTarget()}; memory in ${dataDir()})`)}`);
  // Runs while the models start; the prompt picks it up once it answers.
  const updateCheck = checkForUpdate();
  const memory = new Memory();
  await memory.init();
  const pulled = await memory.pull();
  if (pulled) say(pulled, "dim");
  const hasFull = await exists(scriptPath("full"));
  const booted = await boot(memory, hasFull);
  // The local bootstrap is stopped while the full model runs (handover), and
  // started again if that fails or stops answering.
  let llama = booted.llama;
  const server = booted.llama?.server ?? booted.deferred;
  const control: BootstrapControl | undefined = server
    ? {
      running: () => llama !== null,
      stop: async () => {
        const l = llama;
        llama = null;
        l?.stop();
        await l?.exited;
      },
      start: async () => {
        llama = await startLlama(server);
        return llama.endpoint;
      },
    }
    : undefined;
  const router = new Router(booted.bootstrap, control);
  router.onNotice = (s) => warn(s);
  let smart = await restoreSmart(router);
  let failure: FullFailure | null = null;
  if (!smart && hasFull) {
    // Nothing answering: hand over to the full model's start script.
    await router.handover();
    const saved = (await loadSmart()).find((e) => !e.keyInMemory) ?? null;
    const size = saved ? await downloadSize(saved.model) : undefined;
    const r = await startFull(saved, undefined, undefined, size).catch(
      (e) => {
        warn(`could not start the full model: ${(e as Error).message}`);
        return null;
      },
    );
    // Not up: the small model takes over (started now if it was never started).
    if (!(r && "ep" in r)) await router.ensureBootstrap();
    if (r && "ep" in r) {
      smart = r.ep;
      router.setSmart(smart);
      await saveSmart(smart);
    } else if (r) {
      failure = r.failure;
      warn(
        `the full model did not start: ${failure.reason}${
          failure.cause ? ` (likely cause: ${failure.cause})` : ""
        }`,
      );
    }
  }
  if (smart) {
    const gpu = hasFull ? await gpuOffload(logPath("full")) : null;
    say(
      `${bold("smart model:")} ${smart.label} ${dim(smart.baseUrl)}${gpu ? dim(` (${gpu})`) : ""}`,
    );
  }

  const session = new Session(router, memory, new McpManager(), makeNearAsker());
  session.fullFailure = failure;
  updateCheck.then((u) => {
    if (!u) return;
    session.update = u;
    info(`ai-bootstrap ${u.version} is available (this is ${VERSION}): ${u.url}`);
  });
  await session.init();
  const others = booted.sources.filter((s) =>
    s.endpoint.baseUrl !== router.bootstrap.baseUrl || s.endpoint.model !== router.bootstrap.model
  );
  const agent = new Agent(
    session,
    () =>
      others.length
        ? `Other AI sources seen at boot (candidates for use_model):\n${
          others.map((s) =>
            `- ${s.endpoint.model} at ${s.endpoint.baseUrl}${
              s.endpoint.keyEnv ? ` (key in ${s.endpoint.keyEnv})` : ""
            }`
          ).join("\n")
        }\n`
        : "",
  );

  // ^C stops a model reply; outside one it quits. (At the prompt the
  // terminal is raw, and the line reader sees ^C itself.)
  const onSigint = () => {
    if (!agent.interrupt()) {
      llama?.stop();
      frontend().close();
      Deno.exit(130);
    }
  };
  onInterrupt = onSigint;
  emit({
    type: "status",
    model: router.current().label,
    location: session.where(),
    full: router.current() !== router.bootstrap,
  });
  try {
    Deno.addSignalListener("SIGINT", onSigint);
  } catch {
    // not supported here
  }
  try {
    await repl(agent);
  } finally {
    await session.closeAll();
    llama?.stop();
    frontend().close();
  }
  return 0;
}

/** A terminal that can take the full-screen interface. */
export function modernTerminal(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  const term = env("TERM") ?? "";
  if (term === "dumb") return false;
  if (env("WT_SESSION") || env("TERM_PROGRAM")) return true;
  return /^(xterm|screen|tmux|rxvt|kitty|alacritty|wezterm|ghostty|foot|konsole|gnome|vte|st-|iterm|linux)/
    .test(term);
}

/** --tui or --repl decide; then AIBOOT_UI; otherwise the TUI on a capable terminal. */
function wantTui(flag?: string): boolean {
  if (flag === "--tui") return true;
  if (flag === "--repl") return false;
  const ui = Deno.env.get("AIBOOT_UI");
  if (ui === "tui") return true;
  if (ui === "repl" || ui === "line") return false;
  return Deno.stdin.isTerminal() && Deno.stdout.isTerminal() && modernTerminal();
}

async function main(args: string[]): Promise<number> {
  // ssh runs us as SSH_ASKPASS with the prompt as the only argument.
  if (args[0] === "--askpass") return await askpassMain(args.slice(1).join(" "));
  if (Deno.env.get("AIBOOT_ASKPASS_TOKEN") && !args[0]?.startsWith("--")) {
    return await askpassMain(args.join(" "));
  }
  switch (args[0]) {
    case "--json-eval":
      // The json_eval sandbox (jsoneval.ts): gives up every permission first.
      return await jsonEvalMain();
    case "--far":
      return await farMain();
    case "--version":
      console.log(`ai-bootstrap ${VERSION} ${currentTarget()}`);
      return 0;
    case "--docs": {
      // The knowledge base bundled into this binary.
      for (const n of await new Memory().docNames()) console.log(`docs/${n}`);
      return 0;
    }
    case "--search": {
      const hits = await new Memory().search(args.slice(1).join(" "));
      for (const h of hits) console.log(`${h.source}:${h.line}: ${h.text}`);
      return hits.length ? 0 : 1;
    }
    case "--paths":
      console.log(
        `data:    ${dataDir()}\nmodels:  ${modelsDir()}\nscripts: ${scriptsDir()}\ncache:   ${cacheDir()}`,
      );
      return 0;
    case undefined:
    case "--tui":
    case "--repl":
      return await interactive(wantTui(args[0]));
    default:
      console.log(
        "usage: ai-bootstrap [--tui | --repl | --version | --paths | --docs | --search WORDS]",
      );
      return 2;
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (e) {
    frontend().close();
    console.error(red(`ai-bootstrap: ${(e as Error).message}`));
    Deno.exit(1);
  }
}
