---
hosts: all
verify: command -v curl && command -v jq && command -v chronyc
verify: test "$(timedatectl show -p Timezone --value)" = UTC
verify: chronyc tracking >/dev/null
---
# Base system

Install the base packages `curl`, `jq`, `htop` and `chrony` with the host's
package manager, set the timezone to UTC, and make sure chrony is enabled and
running (the service is `chrony` on Debian/Ubuntu and `chronyd` on Fedora).
