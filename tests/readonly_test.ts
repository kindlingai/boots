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
      "system_profiler SPDisplaysDataType SPHardwareDataType",
      "sysctl -n hw.memsize machdep.cpu.brand_string",
      'echo "home is $HOME"',
      "echo '--- gpu ---'; nvidia-smi -L",
      'grep -E "a|b;c" /etc/os-release',
      "echo ${PATH}",
      "sort < /etc/passwd | head -3",
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader",
      "docker compose ps",
      "(cd /tmp && ls)",
      "brew list --versions",
      "date +%s",
      "env",
      "rocm-smi --showmeminfo vram",
      "ls &>/dev/null",
      "vm_stat; sw_vers",
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
      'echo "$(rm -rf /)"',
      "echo hi >/tmp/x",
      "echo hi>/tmp/x",
      "echo hi &>/tmp/x",
      "echo hi >>'/tmp/x'",
      "cat <<EOF\nhi\nEOF",
      "diff <(ls) <(ls /)",
      "echo 'unterminated",
      "env FOO=1 rm x",
      "sysctl -w vm.swappiness=10",
      "sysctl vm.swappiness=10",
      "nvidia-smi -pm 1",
      "nvidia-smi -pl 200",
      "nvidia-smi -c 0",
      "dmesg -C",
      "docker compose up -d",
      "ldconfig",
      "command rm x",
      "date -s 2020-01-01",
      "\\rm x",
      "e\\cho hi > /tmp/x",
      '"rm" -rf /tmp/x',
      "ls | tee /tmp/x",
      "nvram boot-args=-v",
      "timedatectl set-time 12:00",
    ]
  ) assertFalse(isReadonly(c), c);
});
