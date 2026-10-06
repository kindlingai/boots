import { assert, assertFalse } from "@std/assert";
import { isReadonly } from "../src/readonly.ts";

Deno.test("read-only commands pass", () => {
  for (
    const c of [
      "ls -la /etc",
      "cat /etc/os-release | grep ID",
      "uname -a && nproc",
      "nvidia-smi",
      "nvidia-smi --query-gpu=name,memory.total --format=csv",
      "docker ps -a",
      "systemctl status ollama",
      "git log --oneline | head",
      "grep -r foo . 2>/dev/null",
      "ip -br addr",
      "LANG=C df -h",
    ]
  ) assert(isReadonly(c), c);
});

Deno.test("anything that writes or escapes asks", () => {
  for (
    const c of [
      "rm -rf /tmp/x",
      "echo hi > /tmp/x",
      "ls; rm x",
      "cat $(which foo)",
      "echo `id`",
      "find . -delete",
      "sort -o out in",
      "git -c alias.x=!sh x",
      "git branch new",
      "docker run ubuntu",
      "systemctl restart ollama",
      "ip link set eth0 down",
      "apt-get install -y curl",
      "pip install vllm",
      "hostname newname",
      "",
    ]
  ) assertFalse(isReadonly(c), c);
});
