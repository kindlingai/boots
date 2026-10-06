#!/bin/sh
# End-to-end over real ssh: password auth through askpass, sudo using the
# remembered ssh password, a nested second hop with a host-key question, and
# installing the far binary on both hops. Drives a compiled binary with a
# scripted mock model and scripted keyboard input.
#
# Needs an sshd with password auth and two users, e.g.:
#   HOP1=ops@127.0.0.1 HOP1_PW=opspw   (with `ops ALL=(ALL) ALL` in sudoers)
#   HOP2=ops2@127.0.0.1 HOP2_PW=ops2pw
#   PORT=2222
# usage: tests/e2e_ssh.sh dist/ai-bootstrap
set -eu
bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
root=$(cd "$(dirname "$0")/.." && pwd)
: "${HOP1:=ops@127.0.0.1}" "${HOP1_PW:=opspw}" "${HOP2:=ops2@127.0.0.1}" "${HOP2_PW:=ops2pw}" "${PORT:=2222}"
work=$(mktemp -d /tmp/aib-e2e.XXXX)
trap 'kill $mock 2>/dev/null; rm -rf "$work"' EXIT
target=/tmp/aiboot-e2e-$$.txt

cat > "$work/script.json" <<JSON
[
  {"content": "Planning.", "calls": [{"name": "plan", "args": {"steps": [{"step": "inspect", "status": "in_progress"}]}}, {"name": "run", "args": {"command": "uname -s"}}]},
  {"calls": [{"name": "ssh", "args": {"destination": "$HOP1", "port": $PORT}}]},
  {"calls": [{"name": "sudo", "args": {"command": "id -u"}}]},
  {"calls": [{"name": "ssh", "args": {"destination": "$HOP2", "port": $PORT}}]},
  {"calls": [{"name": "run", "args": {"command": "id -un"}}]},
  {"calls": [{"name": "write_file", "args": {"path": "$target", "content": "hi\\n"}}]},
  {"calls": [{"name": "ssh_exit", "args": {}}]},
  {"calls": [{"name": "ssh_exit", "args": {}}]},
  {"content": "All done."}
]
JSON
(cd "$root" && MOCK_LOG=1 exec deno run -A tests/fixtures/mock_llm.ts "$work/script.json" 18997) > "$work/mock.log" 2>&1 &
mock=$!
sleep 2
# Answers: bootstrap choice, task, ssh ok, password, remember, sudo ok,
# ssh ok, host key, password, remember, write ok, quit.
printf '%s\n' 1 "go" y "$HOP1_PW" y y y yes "$HOP2_PW" y y /quit |
  AIBOOT_HOME="$work/h" AIBOOT_CACHE="$work/c" OPENAI_BASE_URL=http://127.0.0.1:18997/v1 OPENAI_MODEL=mock \
  "$bin" > "$work/out.txt" 2>&1 || { cat "$work/out.txt"; exit 1; }

fail() { cat "$work/out.txt" "$work/mock.log"; echo "FAIL: $*"; exit 1; }
grep -qx "0" "$work/mock.log" || fail "sudo id -u did not return 0"
grep -qx "${HOP2%@*}" "$work/mock.log" || fail "second hop did not run as ${HOP2%@*}"
grep -q "wrote 3 bytes to $target" "$work/mock.log" || fail "write on the second hop"
echo "e2e_ssh: ok"
