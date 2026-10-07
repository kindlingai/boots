import { assert, assertEquals, assertFalse } from "@std/assert";
import { isReadonly, unrollLoops, unwrapShell } from "../src/readonly.ts";

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
      "curl -s http://127.0.0.1:8080/v1/models",
      "curl -sf -m 5 localhost:11434/api/tags | jq .",
      "curl -s -H 'Authorization: Bearer x' http://192.168.1.211:8021/v1/models",
      "curl -sI http://gx10-efcd:8000/health",
      "pgrep -af llama-server",
      "ping -c 3 192.168.1.211",
      "tree -L 2 ~/models",
      "mount",
      "findmnt -T /data",
      "dig +short gx10.local",
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 admin@192.168.1.211 "cat /home/admin/models/x/config.json 2>/dev/null" 2>&1`,
      "ssh -p 2222 gx10 nvidia-smi",
      "ssh admin@gx10 'ls -la ~/models | grep gguf'",
    ]
  ) assert(isReadonly(c), c);
});

Deno.test("curl beyond this machine and private networks, or sending, asks", () => {
  for (
    const c of [
      "curl -s https://example.com",
      "curl -s -o model.gguf http://127.0.0.1/x",
      "curl -X POST http://127.0.0.1:8080/v1/chat/completions",
      "curl -d '{}' http://localhost:8080/x",
      "curl --upload-file f http://10.0.0.2/",
      "curl -sK cfg http://localhost/",
      "curl -s",
      "ping 192.168.1.1",
      "ifconfig eth0 down",
      "route add default gw 10.0.0.1",
      "ssh gx10",
      "ssh gx10 rm -rf /tmp/x",
      "ssh admin@gx10 'ls; touch x'",
      "ssh -L 8000:localhost:8000 gx10 ls",
      "ssh -o ProxyCommand='nc %h %p' gx10 ls",
      "ssh -o LocalCommand=id -o PermitLocalCommand=yes gx10 ls",
      "ssh -A gx10 ls",
    ]
  ) assertFalse(isReadonly(c), c);
});

Deno.test("anything that writes or escapes asks", () => {
  for (
    const c of [
      "rm -rf /tmp/x",
      "echo hi > /tmp/x",
      "ls; rm x",
      "cat $(rm -f foo)",
      "echo `rm -f x`",
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

Deno.test("for loops over literal words are checked as the commands they run", () => {
  assertEquals(
    unrollLoops('for h in gx10 spark; do ssh-keygen -F "$h"; done'),
    'ssh-keygen -F "gx10"; ssh-keygen -F "spark"',
  );
  assertEquals(
    unrollLoops("for f in a.log 'b c.log'; do wc -l \"${f}\"; done | sort"),
    '( wc -l "a.log"; wc -l "b c.log" ) | sort',
  );
  assertEquals(
    unrollLoops("echo start && for p in 8000 8080\ndo\n  lsof -i :$p\ndone"),
    "echo start && ( lsof -i :8000; lsof -i :8080 )",
  );
  // Read-only once unrolled; the loop itself never was.
  assert(isReadonly(unrollLoops("for d in /tmp /var/log; do ls -la $d; done")));
  assert(!isReadonly(unrollLoops("for d in /tmp /var/log; do rm -rf $d; done")));
  // Left alone: globs, substitutions, variables, $v in single quotes,
  // nested loops, break, and values the shell would treat specially.
  for (
    const c of [
      "for f in *.log; do cat $f; done",
      "for f in $(ls); do cat $f; done",
      "for f in $FILES; do cat $f; done",
      "for f in a b; do echo '$f'; done",
      "for f in a b; do for g in c; do echo $f$g; done; done",
      "for f in a b; do cat $f || break; done",
      'for f in "a;rm -rf ~" b; do echo $f; done',
      "for f in ~/x; do cat $f; done",
      "for f in {a,b}; do cat $f; done",
    ]
  ) assertEquals(unrollLoops(c), c, c);
  // $fx is another variable, not $f followed by x.
  assertEquals(unrollLoops("for f in a; do echo $fx $f; done"), "echo $fx a");
});

Deno.test("bash -c / sh -c / zsh -c are checked as the script they run", () => {
  assertEquals(unwrapShell("bash -c 'ls -la /srv; df -h'"), "ls -la /srv; df -h");
  assertEquals(unwrapShell('sh -c "nvidia-smi -L"'), "nvidia-smi -L");
  assertEquals(unwrapShell("zsh -ec 'ls'"), "ls");
  assertEquals(unwrapShell("/bin/bash -e -o pipefail -c 'ls | wc -l'"), "ls | wc -l");
  assertEquals(unwrapShell(`bash -c "sh -c 'uptime'"`), "uptime", "nested");
  assert(isReadonly(unwrapShell("bash -c 'ls -la /srv/models/; readlink -f /srv/x'")));
  assert(!isReadonly(unwrapShell("bash -c 'rm -rf /srv/models'")));
  // Left as they were: arguments after the script, expansions the outer
  // shell would do, a login shell, and a script that is only part of a line.
  for (
    const c of [
      "bash -c 'ls $1' _ /etc",
      'bash -c "ls $HOME"',
      'sh -c "echo `id`"',
      "bash -lc 'ls'",
      "bash -c 'ls' && rm -rf /x",
      "bash -c 'it'\\''s'",
    ]
  ) assertEquals(unwrapShell(c), c, c);
});

Deno.test("reads reported as asking: systemctl verbs, timeout, awk, python arithmetic, loop redirects", () => {
  const ok = [
    "systemctl get-default",
    "systemctl list-timers",
    "systemctl --user is-active mentatd 2>/dev/null",
    "systemctl --no-pager --user status mentatd",
    "ls ~; ls ~/compose-tf-batch 2>/dev/null | head; ls ~/*.sh 2>/dev/null; systemctl is-active mentatd 2>/dev/null; systemctl --user is-active mentatd 2>/dev/null",
    `timeout 25 ssh -o BatchMode=yes -o ConnectTimeout=6 admin@192.168.1.36 'hostname; ls -d /srv/models/glm-*; pgrep -c mentatd; docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | head -6'; echo ===93`,
    `free -g | awk "NR==2{print \\$2\\" GB RAM\\"}"`,
    `awk '$3>5 {print $1}' /proc/meminfo`,
    `grep -o '"total_size":[0-9]*' /srv/x/model.safetensors.index.json; python3 -c "print(190.3*1.05)"`,
    `python3 -c "print(round(2**30/1e9, 2))"`,
  ];
  for (const c of ok) assert(isReadonly(c), c);
  const loop =
    `for h in 192.168.1.36 192.168.1.93; do echo "-- $h"; ssh -o BatchMode=yes admin@$h hostname; done 2>&1 | tail -8`;
  assert(isReadonly(unrollLoops(loop)), "a loop followed by redirections unrolls");
  const no = [
    "timeout 25 rm -rf /x",
    `awk '{print $1 > "out"}' f`,
    `awk 'BEGIN{system("id")}'`,
    `awk '{print | "sh"}' f`,
    "awk -f prog.awk f",
    `python3 -c "import os; os.remove('x')"`,
    `python3 -c "open('x','w')"`,
    `python3 -c "__import__('os')"`,
    "systemctl set-default graphical.target",
    "systemctl --user restart mentatd",
    "systemctl --user --now enable x",
    `docker ps -a 2>err1.txt; cat err1.txt; rm -f err1.txt`,
  ];
  for (const c of no) assertFalse(isReadonly(c), c);
});
