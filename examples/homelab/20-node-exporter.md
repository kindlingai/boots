---
hosts: all
difficulty: hard
verify: curl -sf http://127.0.0.1:9100/metrics | grep -q node_cpu_seconds_total
---
# Prometheus node exporter

Run the Prometheus node exporter on port 9100 as a systemd service under a
dedicated `node_exporter` system user. Prefer the distribution package
(`prometheus-node-exporter` on Debian/Ubuntu, `node-exporter` on Fedora); if
none exists, install the latest release binary for the host's architecture
from GitHub into /usr/local/bin and write a unit file for it.
