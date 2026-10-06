#!/bin/sh
# End-to-end: compile aiboot, run it against a mock model and a `local` host.
# usage: tests/e2e.sh   (needs marsh, python3, curl, jq)
#
# AIBOOT_TEST_HOST="ops@127.0.0.1:2222 sudo" runs it over ssh instead, and
# AIBOOT_TEST_TARGET then defaults to a root-owned path to prove sudo works.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'kill $mock 2>/dev/null || true; rm -rf "$work"' EXIT
port=18999
host=${AIBOOT_TEST_HOST:-local}
if [ "$host" = local ]; then
  export AIBOOT_TEST_TARGET="$work/target/hello.txt"
else
  export AIBOOT_TEST_TARGET="${AIBOOT_TEST_TARGET:-/etc/aiboot-e2e-hello.txt}"
  ssh_dest=${host%% *}
  ssh_port=${ssh_dest##*:}; ssh_dest=${ssh_dest%:*}
  ssh -o BatchMode=yes -p "$ssh_port" "$ssh_dest" "sudo -n rm -f $AIBOOT_TEST_TARGET"
fi
mkdir -p "$work/target" "$work/cluster"

python3 -I "$root/tests/mock_llm.py" $port 2> "$work/mock.log" &
mock=$!
i=0; until curl -sf "http://127.0.0.1:$port/v1/models" >/dev/null; do i=$((i+1)); [ $i -lt 50 ] || exit 1; sleep 0.1; done

cat > "$work/cluster/inventory" <<INV
# name  destination  options
here    $host        roles=bootstrap
INV
echo "A one-node test cluster." > "$work/cluster/cluster.md"
cat > "$work/cluster/10-hello.md" <<R
---
hosts: role:bootstrap
verify: grep -q hello $AIBOOT_TEST_TARGET
verify: grep -q world $AIBOOT_TEST_TARGET
---
Create $AIBOOT_TEST_TARGET containing hello and world.
R
cat > "$work/cluster/20-hard.md" <<R
---
hosts: all
difficulty: hard
---
Check the file.
R
cat > "$work/cluster/30-noop.md" <<R
---
hosts: here
verify: true
---
Already done.
R

marsh build "$root/aiboot.marsh" -o "$work/aiboot.sh"
AIBOOT_WORKER_URL="http://127.0.0.1:$port/v1" \
AIBOOT_ADVISORS="http://127.0.0.1:$port/v1#mock-big-30b" \
AIBOOT_NO_SCROUNGE=1 AIBOOT_NO_LAUNCH=1 AIBOOT_LOG_DIR="$work/logs" \
  sh "$work/aiboot.sh" "$work/cluster" > "$work/out.txt" 2>&1 || { cat "$work/out.txt"; exit 1; }
cat "$work/out.txt"

fail() { echo "FAIL: $*"; exit 1; }
grep -q '10-hello @ here: done' "$work/out.txt" || fail "10-hello not done"
grep -q '20-hard @ here: done' "$work/out.txt" || fail "20-hard not done"
grep -q '30-noop @ here: skipped' "$work/out.txt" || fail "30-noop not skipped"
grep -q 'verification failed (1)' "$work/out.txt" || fail "no verify retry"
if [ "$host" = local ]; then
  [ "$(cat "$AIBOOT_TEST_TARGET")" = "hello
world" ] || fail "target content"
  [ "$(stat -c %a "$AIBOOT_TEST_TARGET" 2>/dev/null || stat -f %Lp "$AIBOOT_TEST_TARGET")" = 600 ] || fail "mode"
else
  [ "$(ssh -o BatchMode=yes -p "$ssh_port" "$ssh_dest" "sudo -n stat -c '%U %a' $AIBOOT_TEST_TARGET")" = "root 600" ] || fail "remote owner/mode"
fi
log=$(ls -d "$work"/logs/*/20-hard--here)
grep -q 'via-text' "$log/messages.jsonl" || fail "text tool call not recovered"
grep -q 'refused: that command matches' "$log/messages.jsonl" || fail "seatbelt"
grep -q 'ADVICE' "$log/messages.jsonl" || fail "advisor not consulted"
echo "e2e: ok"
