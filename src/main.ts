// ai-bootstrap: a minimal agent harness that bootstraps AI infrastructure.
//
//   ai-bootstrap              interactive session (TUI on a modern terminal, else REPL)
//   ai-bootstrap --gui        the same in a window (opt-in; AIBOOT_UI=gui)
//   ai-bootstrap --far        far agent (started by ai-bootstrap over ssh)
//   ai-bootstrap --version

import { NO_PERMISSIONS, parsePermissionFlags, type Permissions } from "./tools.ts";
import { cleanUpgradeLeftovers, upgradeMain } from "./upgrade.ts";
import { Transcript } from "./transcript.ts";
import { checkForUpdate } from "./update.ts";
import { askpassMain } from "./askpass.ts";
import { farMain } from "./far.ts";
import { jsonEvalMain } from "./jsoneval.ts";
import { Memory } from "./memory.ts";
import { McpManager } from "./mcp.ts";
import { type BootstrapControl, type Endpoint, Router } from "./llm.ts";
import { makeNearAsker } from "./secrets.ts";
import { loadSmart, restoreSmart, saveSmart, Session } from "./tools.ts";
import { type FullFailure, gpuOffload, logPath, scriptPath, startFull } from "./intelligence.ts";
import { startLlama } from "./llama.ts";
import { downloadSize } from "./rails.ts";
import { Agent, repl } from "./agent.ts";
import { boot } from "./boot.ts";
import { pinnedEndpoint } from "./discover.ts";
import { offerOffline } from "./setup.ts";
import {
  cacheDir,
  currentTarget,
  dataDir,
  exists,
  modelsDir,
  scriptsDir,
  VERSION,
} from "./platform.ts";
import { bold, dim, info, red, say, setColor, warn } from "./ui.ts";
import { emit, frontend, setFrontend, setInterruptHandler } from "./frontend.ts";
import { TuiFrontend } from "./frontends/tui.ts";
import { GuiFrontend } from "./frontends/gui.ts";
import { windowMain } from "./frontends/window.ts";

async function interactive(mode: UiMode, perms: Permissions = NO_PERMISSIONS): Promise<number> {
  // Binaries an upgrade on Windows renamed aside.
  void cleanUpgradeLeftovers();
  // ^C at the TUI's input arrives as a key, not a signal: it goes through here too.
  let onInterrupt = () => {};
  // Closing the GUI window or its Quit button: stop what runs, then end.
  let onQuit = () => {};
  if (mode === "gui") {
    // The page draws the colours itself, terminal or not.
    setColor(true);
    const g = new GuiFrontend({ title: `ai-bootstrap ${VERSION}`, onQuit: () => onQuit() });
    const url = g.serve();
    setFrontend(g);
    const how = await g.open((s) => console.error(s));
    console.error(
      how === "window"
        ? `ai-bootstrap is running in its window (${url})`
        : how === "browser"
        ? `ai-bootstrap is running in your browser: ${url}`
        : `open this in a browser to use ai-bootstrap: ${url}`,
    );
  }
  if (mode === "tui") {
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
  // OPENAI_BASE_URL given: that one endpoint is every model (bootstrap and
  // full) until the model switches; no saved or scripted full model starts.
  const pinned = await pinnedEndpoint();
  const hasFull = !pinned && await exists(scriptPath("full"));
  const booted = await boot(memory, hasFull, pinned);
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
  let smart: Endpoint | null = null;
  if (pinned) {
    smart = { ...pinned };
    router.setSmart(smart);
  } else smart = await restoreSmart(router);
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
  session.applyPermissions(perms);
  if (perms.skip) {
    warn(
      "--dangerously-skip-permissions: nothing will ask before it runs, sudo and dangerous commands included.",
    );
  }
  session.fullFailure = failure;
  if (Deno.env.get("AIBOOT_HISTORY") !== "0") {
    session.transcript = new Transcript();
    await session.transcript.init();
  }
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
  const restored = await agent.restore(6);
  if (restored) {
    say(
      dim(
        `restored the last ${restored} turn${restored === 1 ? "" : "s"} of the previous session:`,
      ),
    );
    await agent.showRestored();
    if (agent.restoredFrom) {
      warn(
        `the previous session was connected to ${agent.restoredFrom}; that connection was interrupted, so this one starts on the local machine`,
      );
    }
  }

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
  onQuit = () => void agent.interrupt();
  setInterruptHandler((kind) => kind === "esc" ? void agent.interrupt() : onSigint());
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
  // Started with a key or an endpoint: asked once about offline use too.
  const setupNote = booted.hosted && !hasFull
    ? await offerOffline(router.current().label).catch((e) => {
      warn(`offline setup: ${(e as Error).message}`);
      return null;
    })
    : null;
  try {
    await repl(agent, setupNote);
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

export type UiMode = "gui" | "tui" | "repl";

/**
 * --gui, --tui or --repl decide; then AIBOOT_UI; otherwise the TUI on a
 * capable terminal. The GUI is only ever chosen on request.
 */
export function uiMode(
  flag?: string,
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
  terminal: boolean = Deno.stdin.isTerminal() && Deno.stdout.isTerminal(),
): UiMode {
  if (flag === "--gui") return "gui";
  if (flag === "--tui") return "tui";
  if (flag === "--repl") return "repl";
  const ui = env("AIBOOT_UI");
  if (ui === "gui") return "gui";
  if (ui === "tui") return "tui";
  if (ui === "repl" || ui === "line") return "repl";
  return terminal && modernTerminal(env) ? "tui" : "repl";
}

async function main(argv: string[]): Promise<number> {
  // Permission flags may come anywhere; the rest picks what to do.
  const { perms, rest: args } = argv.some((a) => /^--(allow-|dangerously-)/.test(a))
    ? parsePermissionFlags(argv)
    : { perms: NO_PERMISSIONS, rest: argv };
  // --openai-url URL / --openai-model NAME: the same as OPENAI_BASE_URL / OPENAI_MODEL.
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--openai-(url|model)(?:=(.*))?$/);
    if (!m) continue;
    const value = m[2] ?? args[i + 1];
    if (!value || value.startsWith("--")) {
      console.error(`--openai-${m[1]} needs a value`);
      return 2;
    }
    Deno.env.set(m[1] === "url" ? "OPENAI_BASE_URL" : "OPENAI_MODEL", value);
    args.splice(i, m[2] === undefined ? 2 : 1);
    i--;
  }
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
    case "upgrade":
    case "--upgrade":
      return await upgradeMain(args.slice(1));
    case "--gui-window":
      return await windowMain(args[1] ?? "", args[2] ?? "ai-bootstrap");
    case undefined:
    case "--gui":
    case "--tui":
    case "--repl":
      return await interactive(uiMode(args[0]), perms);
    default:
      console.log(
        "usage: ai-bootstrap [--gui | --tui | --repl] [--allow-read-only] [--allow-host HOST]... [--allow-all-hosts] [--dangerously-skip-permissions]\n                    [--openai-url URL [--openai-model NAME]]\n       ai-bootstrap upgrade [VERSION] [--force] | --version | --paths | --docs | --search WORDS",
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
