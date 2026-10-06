# ai-bootstrap

A single portable shell script that configures a cluster without anyone
watching. A small local model (Qwen3 4B, CPU only) reads a directory of plain
English recipes and carries them out over SSH, host by host. When it gets
stuck, it asks a bigger model: first one that is already running somewhere,
and otherwise one it starts on a GPU box.

The script is written in [marsh](https://github.com/mmastrac/marsh) and
compiles to one POSIX `.sh` file. That file needs only `sh`, `curl`, `jq`,
`ssh`, and `docker` (Docker is only needed to run the model).

```
            bootstrap machine                                cluster
 ┌──────────────────────────────────────┐
 │ aiboot.sh (marsh → POSIX sh)         │   ssh hop: one persistent shell
 │  ├─ recipe loop, verify, retry ──────┼──────────────► node-1  (sudo -n sh)
 │  ├─ tools: bash/read/write/finish ───┼──────────────► node-2
 │  │                                   │
 │  ├─ worker: docker aiboot-worker     │
 │  │   llama.cpp + Qwen3-4B (CPU)      │
 │  │   127.0.0.1:18080                 │
 │  └─ advisor (when stuck), in order:  │
 │      1. AIBOOT_ADVISORS              │
 │      2. scrounged: Ollama/vLLM/... ──┼──── probe :11434 :8000 :8080 ... on every host
 │      3. launched: llama.cpp-cuda ────┼──────────────► gpu-1   (docker run)
 └──────────────────────────────────────┘
```

## Quick start

```sh
# build the portable script (or take aiboot.sh from CI artifacts)
marsh build aiboot.marsh -o aiboot.sh

sh aiboot.sh plan examples/homelab        # which recipe runs where
sh aiboot.sh scrounge examples/homelab    # which models are already running
sh aiboot.sh --dry-run examples/homelab   # the model plans, nothing runs
sh aiboot.sh examples/homelab             # do it
```

The first real run pulls `ghcr.io/mmastrac/ai-bootstrap-worker` (about 2.5 GB)
and starts it on `127.0.0.1:18080`. Later runs reuse the container.

## The cluster directory

```
examples/homelab/
  inventory            hosts, one per line
  cluster.md           free text the model reads: conventions, facts, intent
  00-base.md           recipes, applied in name order
  10-containerd.md
  20-node-exporter.md
```

`inventory`:

```
# name      destination              options
nas         root@192.168.1.10        roles=storage
node-1      admin@192.168.1.21       roles=worker sudo
gpu-1       root@192.168.1.30:2222   roles=worker gpu
here        local                    roles=bootstrap
```

- `sudo` runs the remote shell under `sudo -n`, so it needs passwordless sudo.
- `gpu` marks a host where the advisor model may be started.
- `local` is the bootstrap machine itself.

A recipe is Markdown with optional front matter:

```markdown
---
hosts: role:worker            # all | role:<r> | <name>, comma separated
verify: systemctl is-active containerd
verify: ctr version           # repeatable; every check must exit 0
difficulty: hard              # ask the advisor for a plan before starting
max_turns: 40                 # default 30
---
# containerd

Install the distribution's `containerd` package, set `SystemdCgroup = true`,
and enable the service.
```

The `verify` checks do two jobs:

- **Before the run:** if every check already passes, the recipe is skipped on
  that host, so re-running the whole directory is safe.
- **After `finish`:** the checks decide whether the recipe is actually done.
  If they fail, the failure output goes back to the model. After two failures,
  the advisor is consulted automatically.

## How a recipe runs

For each recipe and each target host, aiboot:

1. Opens one persistent remote shell, using heron's far-session protocol
   (vendored in `lib/far_session.marsh`). `cd` and exported variables carry
   from one command to the next, and nothing needs installing on the host.
2. Runs the verify checks and skips the host if they all pass.
3. Starts a fresh conversation bound to that host. The model has six tools:
   - `bash`, `read_file` and `write_file` act on the host.
   - `consult` asks the advisor.
   - `finish` and `give_up` end the recipe.
4. On `finish`, runs the verify checks. Otherwise it keeps going until it runs
   out of turns.

By default the first failure stops the run (`--keep-going` changes that).

To keep a 4B model's context small:

- each conversation covers only one recipe and one host;
- command output is capped at 6 KB;
- tool results older than the last 8 messages are cut down to their head and
  tail.

If a server doesn't parse tool calls natively, Qwen's `<tool_call>` tags are
recovered from the reply text.

## Models

**Worker**, resolved in this order:

1. `AIBOOT_WORKER_URL`
2. a healthy server on `127.0.0.1:18080`
3. a fresh `docker run` of the worker image
4. with no Docker, the largest model scrounged on the network

**Advisor**, resolved lazily, the first time the worker needs help:

1. Each entry in `AIBOOT_ADVISORS`
   (`http://host:port/v1#model[#KEY_ENV]`, comma separated).
2. Scrounged servers. aiboot probes `127.0.0.1`, every inventory host and
   `AIBOOT_SCROUNGE_HOSTS` on the usual ports:
   - Ollama 11434
   - llama.cpp 8080
   - vLLM 8000
   - LM Studio 1234
   - LiteLLM 4000
   - SGLang 30000
   - and a few more

   Models are ranked by the size in their name (`qwen3:32b` → 32,
   `mixtral-8x7b` → 56), and only models larger than the worker are used.
3. Launched. If the bootstrap machine has `nvidia-smi` and Docker, aiboot runs
   `llama.cpp:server-cuda` locally. Otherwise it uses the first `gpu` host in
   the inventory. The model is `AIBOOT_ADVISOR_MODEL`, which defaults to
   `unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:Q4_K_M`; point it at a newer
   Qwen when one suits better. A launched advisor gets a random `--api-key`,
   and its weights are cached in the `aiboot-models` volume. With
   `AIBOOT_ADVISOR_CPU=1` and no GPU anywhere, the same model runs on the
   local CPU. It is a 3B-active mixture-of-experts model, so this is slow but
   usable.

| variable | default | meaning |
|---|---|---|
| `AIBOOT_WORKER_URL` / `_MODEL` / `_KEY_ENV` | | use this worker instead of the container |
| `AIBOOT_WORKER_IMAGE` | `ghcr.io/mmastrac/ai-bootstrap-worker:latest` | worker image |
| `AIBOOT_WORKER_PORT` | `18080` | local worker port |
| `AIBOOT_ADVISORS` | | explicit advisors, tried first |
| `AIBOOT_ADVISOR_MODEL` | Qwen3-30B-A3B Q4_K_M | what to launch when nothing is found |
| `AIBOOT_ADVISOR_PORT` / `_IMAGE` | `18081` / `llama.cpp:server-cuda` | launched advisor |
| `AIBOOT_ADVISOR_CPU=1` | | allow a CPU-only advisor launch |
| `AIBOOT_NO_SCROUNGE=1` / `AIBOOT_NO_LAUNCH=1` | | turn off those steps |
| `AIBOOT_SCROUNGE_HOSTS` / `_PORTS` | | extra hosts / replace the port list |
| `AIBOOT_SSH_OPTS` | | extra ssh words, e.g. `-i key -J bastion` |
| `AIBOOT_MAX_TOKENS` | `2048` | per worker reply |
| `AIBOOT_LOG_DIR` | `aiboot-logs` | where transcripts go |

## The worker image

`container/Dockerfile` adds a GGUF to the upstream llama.cpp CPU server image,
which is published for both amd64 and arm64. CI builds it for both
architectures with buildx and pushes it to GHCR.

To use a fine-tuned model:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg MODEL_URL=https://.../my-finetune-Q4_K_M.gguf container/
```

## Fine-tuning data

Every run leaves `aiboot-logs/<stamp>/<recipe>--<host>/messages.jsonl`, which
is an OpenAI-format chat with tool calls. The transcripts that ended in
`done`, especially the ones where the advisor stepped in, are ready-made
supervised fine-tuning data for the 4B model. That is the intended path from
stock to tuned.

## Safety

- The model runs unattended, with whatever rights the inventory gives it.
  Point it at machines you can rebuild.
- `--dry-run` executes nothing on the hosts. It still runs the model.
- There is a seatbelt that refuses obvious disasters (`rm -rf /`, `mkfs`,
  `dd` to a disk, `wipefs`, reboot/shutdown) unless you pass
  `--allow-dangerous`. It is not a sandbox.
- A scrounged model sees your recipes and command output. To keep that data
  in-house, set `AIBOOT_NO_SCROUNGE=1` and list trusted advisors explicitly.

## Development

```sh
cargo build --release --manifest-path ../marsh/Cargo.toml
export PATH=$PWD/../marsh/target/release:$PATH
marsh check aiboot.marsh
tests/e2e.sh                                         # mock model, local host
AIBOOT_TEST_HOST="ops@127.0.0.1:2222 sudo" tests/e2e.sh   # over real ssh + sudo
```

`tests/mock_llm.py` is a scripted OpenAI-compatible server that plays both the
worker and the advisor. The test checks:

- verify-then-retry
- the `<tool_call>` text fallback
- the seatbelt
- advisor consults
- `write_file` modes
- idempotent skips

## Not done yet

- **Facts across hosts.** A recipe can't yet pass a value from one host to
  another, such as a k3s join token from the server to its agents. The likely
  fix is a `remember`/`recall` tool backed by the run directory.
- **Parallelism.** Hosts run one after another. marsh's `start` and collectors
  make a per-host fan-out straightforward.
- **Model choice.** The 4B and 30B GGUF names are Unsloth's published
  quantizations. Swap them for newer Qwen releases, or your own fine-tune, as
  they appear.
