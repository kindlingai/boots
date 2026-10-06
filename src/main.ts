// ai-bootstrap: a minimal agent harness that bootstraps AI infrastructure.
//
//   ai-bootstrap              interactive session
//   ai-bootstrap --far        far agent (started by ai-bootstrap over ssh)
//   ai-bootstrap --version

import { askpassMain } from "./askpass.ts";
import { farMain } from "./far.ts";
import { Memory } from "./memory.ts";
import { McpManager } from "./mcp.ts";
import { Router } from "./llm.ts";
import { makeNearAsker } from "./secrets.ts";
import { loadSmart, restoreSmart, saveSmart, Session } from "./tools.ts";
import { type FullFailure, startFull } from "./intelligence.ts";
import { Agent, repl } from "./agent.ts";
import { boot } from "./boot.ts";
import { cacheDir, currentTarget, dataDir, modelsDir, scriptsDir, VERSION } from "./platform.ts";
import { bold, dim, red, warn } from "./ui.ts";

async function interactive(): Promise<number> {
  console.log(
    `${bold("ai-bootstrap")} ${VERSION} ${dim(`(${currentTarget()}; memory in ${dataDir()})`)}`,
  );
  const memory = new Memory();
  await memory.init();
  const pulled = await memory.pull();
  if (pulled) console.log(dim(pulled));
  const booted = await boot(memory);
  const router = new Router(booted.bootstrap);
  router.onNotice = (s) => warn(s);
  let smart = await restoreSmart(router);
  let failure: FullFailure | null = null;
  if (!smart) {
    // Nothing answering: start the full model if there is a start-full script.
    const r = await startFull((await loadSmart()).find((e) => !e.keyInMemory) ?? null);
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
  if (smart) console.log(`${bold("smart model:")} ${smart.label} ${dim(smart.baseUrl)}`);

  const session = new Session(router, memory, new McpManager(), makeNearAsker());
  session.fullFailure = failure;
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
      booted.llama?.stop();
      Deno.exit(130);
    }
  };
  try {
    Deno.addSignalListener("SIGINT", onSigint);
  } catch {
    // not supported here
  }
  try {
    await repl(agent);
  } finally {
    await session.closeAll();
    booted.llama?.stop();
  }
  return 0;
}

async function main(args: string[]): Promise<number> {
  // ssh runs us as SSH_ASKPASS with the prompt as the only argument.
  if (args[0] === "--askpass") return await askpassMain(args.slice(1).join(" "));
  if (Deno.env.get("AIBOOT_ASKPASS_TOKEN") && !args[0]?.startsWith("--")) {
    return await askpassMain(args.join(" "));
  }
  switch (args[0]) {
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
      return await interactive();
    default:
      console.log("usage: ai-bootstrap [--version | --paths | --docs | --search WORDS]");
      return 2;
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (e) {
    console.error(red(`ai-bootstrap: ${(e as Error).message}`));
    Deno.exit(1);
  }
}
