# mentat (lightweight cluster manager, Ray replacement)

mentat (https://github.com/kindlingai/mentat) is a self-organizing cluster manager for a small
number of nodes. It runs multi-node vLLM without Ray, and puts one OpenAI-compatible endpoint (and
one merged MCP endpoint) in front of every model in the cluster. Use it for multi-node or
multi-model setups where Ray would be the usual answer (docs/ray) but its weight and failure modes
are unwelcome. For one model on one box, run the engine directly instead.

Versions below are from the 0.19.0 docs; check the releases page for the current one and read
GUIDE.md / GUIDE-SERVE.md in the repository when unsure.

## Parts

| part            | what it does                                                                                                                                                                | port                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `mentatd`       | one daemon per node (host network): cluster state, mesh, head election, placement; also the in-container agent (`mentatd start`) and CLI (`mentatd status`, `mentatd stop`) | 6379/tcp control (what `RAY_ADDRESS` points at), 6380/tcp HTTP (`/status`, `/metrics`, `/events`, `/healthz`) |
| `mentatd-serve` | router: OpenAI API at `/v1` routed by `model`, merged MCP at `/mcp`, status page at `/`                                                                                     | 6381/tcp                                                                                                      |
| `ray` shim      | pure-Python wheel that installs under the `ray` import name and implements what vLLM's Ray executor uses                                                                    | —                                                                                                             |
| announcements   | daemons find each other and the router by signed UDP broadcast                                                                                                              | 6382/udp                                                                                                      |

All binaries are static (linux/amd64 and linux/arm64). There is no object store, memory monitor,
raylet or dashboard.

## Install

- Release binaries, the wheel and SHA256SUMS: https://github.com/kindlingai/mentat/releases
- Artifacts image with both binaries and the wheel:
  `docker pull ghcr.io/kindlingai/mentat-artifacts:0.19.0` (files under `/out/`).
- From source: `cargo install mentatd mentatd-serve` and `pip wheel --no-deps -w dist ./python` for
  the shim (the wheel is not on PyPI).
- Compose files in the repo: `mentatd.yaml` (daemon) and `mentatd-serve.yaml` (router). Both need
  `network_mode: host`.

## Bring up a cluster

1. On **every node**, run the daemon on the host network:

   ```sh
   MENTAT_PEERS=10.0.0.1:6379 mentatd daemon     # or the mentatd.yaml compose file
   ```

   - One `MENTAT_PEERS` entry that reaches any live daemon is enough; the mesh is learned from it.
     With it empty, daemons on the same broadcast domain still find each other via UDP 6382.
   - Start order does not matter: registration retries forever.
   - `MENTAT_NODE_IP` defaults to the default-route address. Set it only on multi-homed nodes where
     that is the wrong link (it must be the address the driver sees itself on).
   - Set the same `MENTAT_SECRET` (or `MENTAT_SECRET_FILE`) on every daemon and router to sign
     announcements. Without it the daemon announces nothing, and the router refuses to start. A
     half-keyed cluster looks empty. Store the key in a file, not in memory notes.
2. Check: `mentatd status` (one line per daemon, peer, island, group, agent), or
   `curl -s http://<node>:6380/status | jq .`.
3. Run the router on any node that reaches every daemon's port 6380 and the model endpoints:

   ```sh
   MENTAT_SECRET_FILE=/etc/mentat/secret mentatd serve      # = mentatd-serve; or mentatd-serve.yaml
   curl -s http://<node>:6381/v1/models
   ```

## Run vLLM on it (replacing Ray)

Convert the model image so `ray` is the shim and the `ray` CLI is mentatd:

```dockerfile
FROM vllm/vllm-openai:<tag>
COPY --from=ghcr.io/kindlingai/mentat-artifacts:0.19.0 /out/mentatd /usr/local/bin/mentatd
COPY --from=ghcr.io/kindlingai/mentat-artifacts:0.19.0 /out/mentatd-0.19.0-py3-none-any.whl /tmp/
RUN ln -s /usr/local/bin/mentatd /usr/local/bin/ray \
 && pip uninstall -y ray \
 && pip install --no-deps /tmp/mentatd-0.19.0-py3-none-any.whl
```

Entrypoint (container on the host network, one `MENTAT_GROUP` per model deployment):

```sh
export VLLM_USE_RAY_V2_EXECUTOR_BACKEND=1     # required; the legacy executor is unsupported
export MENTAT_GROUP=mymodel
export MENTAT_OPENAI_API=8000/v1              # on the rank that serves the API
export MENTAT_MODEL_PROVIDER=vllm
ray start                                     # = mentatd start: the agent detaches beside vllm
vllm serve <model> --host 0.0.0.0 --distributed-executor-backend ray -tp 2
```

- No head address is needed: the container talks to its own node's daemon (`127.0.0.1:6379`), which
  relays to the head.
- Leave `MENTAT_NODE_IP` unset in containers; a wrong value hangs NCCL rendezvous.
- `ray status` is scoped to the group and prints one `N.0/M.0 GPU` line, so existing `GPU >= TP`
  gates keep working. `ray stop` needs `--group NAME` or `--all`.
- The container log shows a banner ending `-- this is NOT real Ray` at `ray.init`; without it the
  container is on real Ray.
- The shim implements only the surface vLLM's `RayExecutorV2` uses (audited against a specific vLLM
  build). After changing the vLLM base image, re-run the audit from GUIDE.md:
  `grep -rn 'ray\.' $(python -c 'import vllm,os;print(os.path.dirname(vllm.__file__))')/v1/executor/`
- Workarounds to delete when migrating from Ray: object-store size flags,
  `RAY_memory_monitor_refresh_ms`, head-first start ordering, `ray stop` between runs.

A single-rank engine (llama.cpp, SGLang, one-GPU vLLM) can still be listed by the router: run
`python -m ray.register &` beside it (from the shim package) with `MENTAT_GROUP` and
`MENTAT_OPENAI_API` set, or `mentatd start` if its GPUs should be placeable.

## Using it from ai-bootstrap

- The router at `http://<node>:6381/v1` is a normal OpenAI-compatible base URL: list models with
  `models_at`, then `use_model` with one of them. ai-bootstrap probes port 6381 on this machine at
  boot.
- `http://<node>:6381/mcp` is an MCP endpoint (streamable HTTP) merging each group's management
  tools plus `serve_status`; add it with `mcp_add` (url form).
- `/status.json` explains a missing model per group (`why_not`: no announced OpenAI endpoint, no
  running actors, endpoint probe failed, ...).

## Fabrics (RDMA / multiple cables)

Only for clusters with more than one RDMA fabric. Tag links on every node, fastest first, e.g.
`MENTAT_ANNOUNCE_IFACES=en*f*np*=connectx+rdma,en*=lan`. Daemons probe each address pair; multi-GPU
placement then stays inside one fabric island, and each rank gets `MENTAT_FABRIC_IP`.
`mentatd status` shows `reach from ...` results and `fabric N:` islands. DGX Spark QSFP ports show
up as two interfaces on one wire; mentat treats the pair as one cable.

## Troubleshooting

- Model missing from `/v1/models`: read `why_not` in `curl -s http://<node>:6381/status.json`. An
  endpoint bound to one address only logs `service_bind_narrow`; use `--host 0.0.0.0`.
- Router sees no daemons: mismatched or missing `MENTAT_SECRET`, different `MENTAT_UNIVERSE`, UDP
  6382 blocked (seed `MENTAT_DAEMONS=<node>:6380`), or an announced address outside
  `ALLOWED_SOURCES`.
- Placement stuck PENDING: `pending_reason` in `/status`; times out after
  `MENTAT_PG_PENDING_TIMEOUT_MS` (10 min).
- A rank died: `actor_exit` with pid and signal in the container log.
- The control port is unauthenticated: keep 6379/6380 on trusted networks.
