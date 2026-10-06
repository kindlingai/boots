---
hosts: role:worker
verify: systemctl is-active containerd
verify: ctr version
verify: grep -q "SystemdCgroup = true" /etc/containerd/config.toml
max_turns: 40
---
# containerd

Install the distribution's `containerd` package. Generate the default config with
`containerd config default`, set `SystemdCgroup = true` under the runc
options, and enable and start the service.
