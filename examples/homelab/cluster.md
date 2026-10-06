A small home lab. Machines are a mix of Debian 12, Ubuntu 24.04 and
Fedora; architectures are x86_64 and aarch64 (Raspberry Pi 5). Detect the
distribution and architecture on each host rather than assuming.

Conventions:
- Timezone is UTC everywhere.
- The admin group is `ops`.
- Services listen on the LAN only (192.168.1.0/24).
