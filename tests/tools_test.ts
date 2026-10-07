import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { Host } from "../src/host.ts";
import { htmlToText } from "../src/tools.ts";

async function git(cwd: string, ...args: string[]) {
  const o = await new Deno.Command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (o.code !== 0) throw new Error(new TextDecoder().decode(o.stderr));
}

Deno.test("git_clone: shallow clone into a temp folder, with files and README", async () => {
  const src = await Deno.makeTempDir();
  await git(src, "init", "-q", "-b", "main");
  await Deno.writeTextFile(join(src, "README.md"), "# Spark recipe\nRun vLLM on two Sparks.\n");
  await Deno.mkdir(join(src, "configs"));
  await Deno.writeTextFile(join(src, "configs", "a.yaml"), "x: 1\n");
  await git(src, "add", "-A");
  await git(src, "commit", "-q", "-m", "init");
  const h = new Host(() => Promise.resolve(null));
  const r: any = await h.handle("git_clone", { url: toFileUrl(src).href }, []);
  assertEquals(r.error, undefined, r.error);
  assertEquals(r.files, ["README.md", "configs/"]);
  assertStringIncludes(r.readme, "two Sparks");
  assert(r.path.includes("ai-bootstrap-clone-"));
  const bad: any = await h.handle("git_clone", { url: "/etc; rm -rf /" }, []);
  assert(bad.error);
  const missing: any = await h.handle("git_clone", { url: toFileUrl(join(src, "nope")).href }, []);
  assert(missing.error);
});

Deno.test("fetch_url turns HTML into readable text", () => {
  const t = htmlToText(
    "<html><head><style>p{}</style><script>x()</script></head><body><h1>Recipe</h1><p>Use &lt;vllm&gt; &amp; ray</p></body></html>",
  );
  assertStringIncludes(t, "Recipe");
  assertStringIncludes(t, "Use <vllm> & ray");
  assert(!t.includes("x()") && !t.includes("<p>"));
});

Deno.test("ssh goes out from the local machine unless hop is asked for", async () => {
  const { Router } = await import("../src/llm.ts");
  const { Memory } = await import("../src/memory.ts");
  const { McpManager } = await import("../src/mcp.ts");
  const { Session } = await import("../src/tools.ts");
  const dir = await Deno.makeTempDir();
  try {
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
      new Memory(`${dir}/mem`),
      new McpManager(`${dir}/mcp.json`),
      () => Promise.resolve(null),
    );
    await s.init();
    const opened: string[] = [];
    const closed: string[] = [];
    let n = 0;
    // No real ssh: record what would be opened from where, and closed.
    (s as any).call = (op: string, a: any) => {
      assertEquals(op, "ssh_open");
      opened.push(`${s.where()} -> ${a.dest}`);
      return Promise.resolve({ id: `c${++n}`, info: { ...s.here.info, hostname: a.dest } });
    };
    (s.host as any).handle = (op: string, a: any) => {
      closed.push(`${op} ${a.id}`);
      return Promise.resolve(null);
    };
    (s as any).always = { has: () => true, add() {} };
    await s.exec("ssh", { destination: "a@one" });
    await s.exec("ssh", { destination: "b@two" });
    assertEquals(s.where(), "local > b@two", "back to local, then out");
    await s.exec("ssh", { destination: "c@three", hop: true });
    assertEquals(s.where(), "local > b@two > c@three", "an explicit hop nests");
    assertEquals(opened, ["local -> a@one", "local -> b@two", "local > b@two -> c@three"]);
    assertEquals(closed, ["ssh_close c1"]);
    assertStringIncludes(await s.exec("ssh", { destination: "a@one" }), "connected");
    assertEquals(s.where(), "local > a@one");
    assertStringIncludes(await s.exec("ssh", { destination: "a@one" }), "already on a@one");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start-full.sh that starts nothing is refused, pointing at use_model", async () => {
  const { refuseStartFull } = await import("../src/tools.ts");
  const remote =
    "#!/bin/sh\n# Starts the full model: qwen on mentat.\n# endpoint: http://192.168.3.7:8000/v1 qwen36-a3b-128k\n";
  assertStringIncludes(refuseStartFull("/x/intelligence/start-full.sh", remote)!, "use_model");
  assertEquals(
    refuseStartFull("C:\\x\\start-full.cmd", "@echo off\r\nrem endpoint: a b\r\n") !== null,
    true,
  );
  assertEquals(
    refuseStartFull("/x/start-full.sh", remote + "exec llama-server -m m.gguf --port 9\n"),
    null,
  );
  assertEquals(refuseStartFull("/x/start-qwen.sh", remote), null, "other scripts are not checked");
});

Deno.test("ssh targets in a command line", async () => {
  const { sshTargets } = await import("../src/tools.ts");
  assertEquals(sshTargets("ssh admin@gx10 nvidia-smi"), ["admin@gx10"]);
  assertEquals(sshTargets("ssh -p 2222 -i ~/.ssh/k -o StrictHostKeyChecking=no gx10 uptime"), [
    "gx10",
  ]);
  assertEquals(sshTargets("ssh -l admin -p22 GX10.local 'ls'"), ["admin@gx10.local"]);
  assertEquals(sshTargets("ssh -tt ssh://admin@10.0.0.5:2200 top"), ["admin@10.0.0.5"]);
  assertEquals(sshTargets("timeout 10 /usr/bin/ssh a@b true; ssh c@d true"), ["a@b", "c@d"]);
  assertEquals(sshTargets("ssh -V"), []);
  assertEquals(sshTargets("cat ~/.ssh/config | grep gx10"), []);
});

Deno.test("a second ssh by hand to the same machine is refused, pointing at the ssh tool", async () => {
  const { Router } = await import("../src/llm.ts");
  const { Memory } = await import("../src/memory.ts");
  const { McpManager } = await import("../src/mcp.ts");
  const { Session } = await import("../src/tools.ts");
  const dir = await Deno.makeTempDir();
  try {
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
      new Memory(`${dir}/mem`),
      new McpManager(`${dir}/mcp.json`),
      () => Promise.resolve(null),
    );
    await s.init();
    const ran: string[] = [];
    (s as any).always = { has: () => true, add() {} };
    (s as any).check = () => Promise.resolve({ verdict: "writes", checked: true });
    (s as any).command = (_op: string, cmd: string) => {
      ran.push(cmd);
      return Promise.resolve({ code: 0, stdout: "ok\n", stderr: "", cmd });
    };
    assertStringIncludes(await s.exec("run", { command: "ssh admin@gx10 nvidia-smi" }), "exit 0");
    assertStringIncludes(await s.exec("run", { command: "ssh other@box uptime" }), "exit 0");
    const second = await s.exec("run", { command: "ssh -p 22 root@GX10 df -h" });
    assertStringIncludes(second, "second command that connects to gx10");
    assertStringIncludes(second, "ssh tool with destination root@gx10");
    assertEquals(ran, ["ssh admin@gx10 nvidia-smi", "ssh other@box uptime"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("after ^C, a command that will not stop is let go within a few seconds", async () => {
  const { Router } = await import("../src/llm.ts");
  const { Memory } = await import("../src/memory.ts");
  const { McpManager } = await import("../src/mcp.ts");
  const { Session } = await import("../src/tools.ts");
  const dir = await Deno.makeTempDir();
  try {
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
      new Memory(`${dir}/mem`),
      new McpManager(`${dir}/mcp.json`),
      () => Promise.resolve(null),
    );
    await s.init();
    (s as any).always = { has: () => true, add() {} };
    (s as any).check = () => Promise.resolve({ verdict: "writes", checked: true });
    // A host whose command ignores the cancel (a root process we cannot signal).
    const never = Promise.withResolvers<unknown>();
    const cancels: string[] = [];
    (s.host as any).handle = (op: string, a: any) => {
      if (op === "cancel") {
        cancels.push(a.token);
        return Promise.resolve(true);
      }
      return never.promise;
    };
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 200);
    const out = await s.exec("run", { command: "sudo-ish build" }, ac.signal);
    const took = Date.now() - t0;
    assert(took < 5000, `let go after ${took} ms`);
    assertEquals(cancels.length, 1, "the cancel was still sent");
    assertStringIncludes(out, "may still be running");
    never.resolve({ code: 0, stdout: "", stderr: "" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sudo asks every time: no always, and none remembered", async () => {
  const { Router } = await import("../src/llm.ts");
  const { Memory } = await import("../src/memory.ts");
  const { McpManager } = await import("../src/mcp.ts");
  const { Session } = await import("../src/tools.ts");
  const { setFrontend } = await import("../src/frontend.ts");
  const dir = await Deno.makeTempDir();
  const prompts: string[] = [];
  const answers = ["a", "y", "y"];
  setFrontend({
    emit() {},
    readLine: (p: string) => {
      prompts.push(p.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), ""));
      return Promise.resolve(answers.shift() ?? null);
    },
    close() {},
  });
  try {
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
      new Memory(`${dir}/mem`),
      new McpManager(`${dir}/mcp.json`),
      () => Promise.resolve(null),
    );
    await s.init();
    (s as any).check = () => Promise.resolve({ verdict: "writes", checked: true });
    const ran: string[] = [];
    (s as any).command = (_op: string, cmd: string) => {
      ran.push(cmd);
      return Promise.resolve({ code: 0, stdout: "", stderr: "", cmd });
    };
    await s.exec("sudo", { command: "systemctl restart ollama" });
    await s.exec("sudo", { command: "systemctl restart ollama" });
    assertEquals(ran.length, 2);
    assertEquals(prompts.length, 3, "'a' is not a choice; the second run asks again");
    assert(prompts.every((p) => !p.includes("[a]lways")), prompts.join(" | "));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sudo: a listed read-only command runs unasked once read-only is allowed; secrets still ask", async () => {
  const { Router } = await import("../src/llm.ts");
  const { Memory } = await import("../src/memory.ts");
  const { McpManager } = await import("../src/mcp.ts");
  const { Session, readsSecrets } = await import("../src/tools.ts");
  const { setFrontend } = await import("../src/frontend.ts");
  const dir = await Deno.makeTempDir();
  const prompts: string[] = [];
  const answers = ["r", "y", "y"];
  setFrontend({
    emit() {},
    readLine: (p: string) => {
      prompts.push(p);
      return Promise.resolve(answers.shift() ?? null);
    },
    close() {},
  });
  try {
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
      new Memory(`${dir}/mem`),
      new McpManager(`${dir}/mcp.json`),
      () => Promise.resolve(null),
    );
    await s.init();
    // The model's checker is never asked here: these are on the fixed list or not at all.
    (s as any).classifier = { classify: () => Promise.resolve("writes") };
    const ran: string[] = [];
    (s as any).command = (_op: string, cmd: string) => {
      ran.push(cmd);
      return Promise.resolve({ code: 0, stdout: "", stderr: "", cmd });
    };
    // First listed read: asks, offering read-only; "r" allows them from now on.
    await s.exec("sudo", { command: "journalctl -u ollama -n 20 --no-pager" });
    assertEquals(prompts.length, 1);
    assertStringIncludes(prompts[0], "[r]ead-only");
    await s.exec("sudo", { command: "ls -la /root" });
    assertEquals(prompts.length, 1, "a listed read now runs unasked");
    // Secrets and anything not on the list still ask.
    await s.exec("sudo", { command: "cat /etc/shadow" });
    assertEquals(prompts.length, 2);
    await s.exec("sudo", { command: "systemctl restart ollama" });
    assertEquals(prompts.length, 3);
    assertEquals(ran.length, 4);
    assert(readsSecrets("cat /home/a/.ssh/id_ed25519") && readsSecrets("cat server.key"));
    assert(!readsSecrets("journalctl -u x"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("/mode auto: safe commands and writes run unasked; dangerous, unjudged and sudo ask; never on the base model", async () => {
  const { Router } = await import("../src/llm.ts");
  const { Memory } = await import("../src/memory.ts");
  const { McpManager } = await import("../src/mcp.ts");
  const { Session } = await import("../src/tools.ts");
  const { setFrontend } = await import("../src/frontend.ts");
  const dir = await Deno.makeTempDir();
  let prompts = 0;
  setFrontend({
    emit() {},
    readLine: () => {
      prompts++;
      return Promise.resolve("y");
    },
    close() {},
  });
  try {
    const make = async (model: string) => {
      const s = new Session(
        new Router({ label: model, baseUrl: "http://127.0.0.1:9/v1", model, contextChars: 1e4 }),
        new Memory(`${dir}/mem-${model}`),
        new McpManager(`${dir}/mcp.json`),
        () => Promise.resolve(null),
      );
      await s.init();
      const verdicts: Record<string, string | null> = {
        "make install": "writes",
        "rm -rf /data": "dangerous",
        "mystery-tool": null,
        "python3 /tmp/check.py": "unknown",
      };
      (s as any).classifier = {
        classify: (c: string) => Promise.resolve(c in verdicts ? verdicts[c] : "writes"),
      };
      (s as any).command = (_op: string, cmd: string) =>
        Promise.resolve({ code: 0, stdout: "", stderr: "", cmd });
      (s as any).call = () => Promise.resolve({ bytes: 1, path: "/tmp/x" });
      s.mode = "auto";
      return s;
    };
    const full = await make("gpt-oss-120b");
    const asked = async (s: any, tool: string, args: any) => {
      const before = prompts;
      await s.exec(tool, args);
      return prompts - before;
    };
    assertEquals(await asked(full, "run", { command: "make install" }), 0, "a write runs unasked");
    assertEquals(await asked(full, "write_file", { path: "/tmp/x", content: "x" }), 0);
    assertEquals(await asked(full, "run", { command: "rm -rf /data" }), 1, "dangerous asks");
    assertEquals(await asked(full, "run", { command: "mystery-tool" }), 1, "unjudged asks");
    assertEquals(
      await asked(full, "run", { command: "python3 /tmp/check.py" }),
      1,
      "a script asks",
    );
    assertEquals(await asked(full, "sudo", { command: "make install" }), 1, "sudo asks");
    const base = await make("qwen3-4b");
    assertEquals(await asked(base, "run", { command: "make install" }), 1, "not on the base model");
    assertEquals(await asked(base, "write_file", { path: "/tmp/x", content: "x" }), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the approval menu keeps wide gaps between its choices", async () => {
  const { approve } = await import("../src/ui.ts");
  const { setFrontend } = await import("../src/frontend.ts");
  const seen: string[] = [];
  setFrontend({
    emit() {},
    readLine: (p: string) => {
      seen.push(p.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), ""));
      return Promise.resolve("n");
    },
    close() {},
  });
  await approve("x", "normal");
  await approve("x", "readonly");
  assertStringIncludes(seen[0], "[y]es   [n]o   [a]lways   [s]omething else");
  assertStringIncludes(seen[1], "[n]o   always allow [r]ead-only   [s]omething");
});

Deno.test("the sudo tool refuses ssh, pointing at the ssh tool", async () => {
  const { Router } = await import("../src/llm.ts");
  const { Memory } = await import("../src/memory.ts");
  const { McpManager } = await import("../src/mcp.ts");
  const { Session } = await import("../src/tools.ts");
  const dir = await Deno.makeTempDir();
  try {
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
      new Memory(`${dir}/mem`),
      new McpManager(`${dir}/mcp.json`),
      () => Promise.resolve(null),
    );
    await s.init();
    let ran = 0;
    (s as any).command = () => {
      ran++;
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const out = await s.exec("sudo", { command: "ssh admin@gx10 'systemctl restart x'" });
    assertStringIncludes(out, "Not run:");
    assertStringIncludes(out, "ssh tool with destination admin@gx10");
    assertEquals(ran, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run: a loop over literal words is checked as the commands it runs", async () => {
  const { Router } = await import("../src/llm.ts");
  const { Memory } = await import("../src/memory.ts");
  const { McpManager } = await import("../src/mcp.ts");
  const { Session } = await import("../src/tools.ts");
  const { setFrontend } = await import("../src/frontend.ts");
  const dir = await Deno.makeTempDir();
  const prompts: string[] = [];
  setFrontend({
    emit() {},
    readLine: (p: string) => {
      prompts.push(p);
      return Promise.resolve("n");
    },
    close() {},
  });
  try {
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
      new Memory(`${dir}/mem`),
      new McpManager(`${dir}/mcp.json`),
      () => Promise.resolve(null),
    );
    await s.init();
    s.allowReadonly = true;
    const judged: string[] = [];
    (s as any).classifier = {
      classify: (c: string) => (judged.push(c), Promise.resolve("writes")),
    };
    (s as any).command = (_op: string, cmd: string) =>
      Promise.resolve({ code: 0, stdout: "", stderr: "", cmd });
    await s.exec("run", { command: "for d in /tmp /var/log; do ls -la $d; done" });
    assertEquals(prompts.length, 0, "read-only once unrolled: runs unasked");
    assertEquals(judged, []);
    await s.exec("run", { command: "for m in a b; do ollama rm $m; done" });
    assertEquals(judged, ["ollama rm a; ollama rm b"], "the checker sees each command");
    assertEquals(prompts.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sudo bash -c '<reads>' runs under always-allow read-only, like the reads themselves", async () => {
  const { Router } = await import("../src/llm.ts");
  const { Memory } = await import("../src/memory.ts");
  const { McpManager } = await import("../src/mcp.ts");
  const { Session } = await import("../src/tools.ts");
  const { setFrontend } = await import("../src/frontend.ts");
  const dir = await Deno.makeTempDir();
  const prompts: string[] = [];
  setFrontend({
    emit() {},
    readLine: (p: string) => {
      prompts.push(p);
      return Promise.resolve("n");
    },
    close() {},
  });
  try {
    const s = new Session(
      new Router({ label: "m", baseUrl: "http://127.0.0.1:9/v1", model: "m", contextChars: 1e4 }),
      new Memory(`${dir}/mem`),
      new McpManager(`${dir}/mcp.json`),
      () => Promise.resolve(null),
    );
    await s.init();
    s.allowReadonly = true;
    const judged: string[] = [];
    (s as any).classifier = {
      classify: (c: string) => (judged.push(c), Promise.resolve("writes")),
      culprit: () => undefined,
    };
    const ran: string[] = [];
    (s as any).command = (_op: string, cmd: string) => {
      ran.push(cmd);
      return Promise.resolve({ code: 0, stdout: "", stderr: "", cmd });
    };
    await s.exec("sudo", {
      command: "bash -c 'ls -la /srv/models/; echo ---; readlink -f /srv/models/x'",
    });
    assertEquals(prompts.length, 0, "read-only once unwrapped");
    assertEquals(judged, []);
    assertEquals(ran.length, 1, "and it runs as written");
    // Not read-only inside: the checker sees the script, and the user is asked.
    await s.exec("run", { command: "sh -c 'ollama rm a && ollama rm b'" });
    assertEquals(judged, ["ollama rm a && ollama rm b"]);
    assertEquals(prompts.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sudo inside run: refused, with the exact split into the sudo tool and run", async () => {
  const { refuseInRun, listItems } = await import("../src/tools.ts");
  const cmd =
    `sudo docker ps --format '{{.Names}} {{.Status}}' | head; ls ~/glm/compose/ 2>/dev/null && ls ~/glm/ | head`;
  assertEquals(listItems(cmd), [
    "sudo docker ps --format '{{.Names}} {{.Status}}' | head",
    "ls ~/glm/compose/ 2>/dev/null",
    "ls ~/glm/ | head",
  ]);
  const r = refuseInRun(cmd)!;
  assertStringIncludes(
    r,
    "the sudo tool with `docker ps --format '{{.Names}} {{.Status}}' | head`",
  );
  assertStringIncludes(r, "then run with `ls ~/glm/compose/ 2>/dev/null; ls ~/glm/ | head`");
  assert(!refuseInRun("sudo -u bob ls; ls")!.includes("Split"), "sudo with options: no guess");
});
