# Docker for model servers

## Why Docker first

On a machine where nothing is set up yet, prefer running each model server (and anything it needs)
as a Docker container instead of installing it on the host:

- **Hermetic**: the engine, its Python, CUDA libraries and dependencies live in the image. Nothing
  is installed into the host's system or the user's Python, so it cannot break other software.
- **Easy to remove**: one command removes a service completely (`docker compose down`, then remove
  the image). The model weights stay in the models folder unless the user wants them gone.
- **Traceable**: labels on every container say that ai-bootstrap made it, what it is for, and which
  script starts it, so `docker ps` shows what exists on the machine and why.
- **Reproducible**: the compose file or start script holds the exact image tag and flags, so
  rerunning it gives the same server.

Install directly on the host only when Docker cannot do the job: macOS (containers cannot use the
Mac GPU; use llama.cpp or MLX natively), or when the user prefers it.

## Conventions for containers ai-bootstrap creates

- **Name**: `aib-<service>`, e.g. `aib-vllm-qwen3`. One compose project per service, with the same
  name.
- **Labels** on every container:

  ```
  --label ai-bootstrap.managed=true
  --label ai-bootstrap.service=<service>
  --label ai-bootstrap.script=<path of the start script>
  --label ai-bootstrap.created=<YYYY-MM-DD>
  ```

  List them:
  `docker ps -a --filter label=ai-bootstrap.managed=true --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'`.
- **Pin the image tag** (`vllm/vllm-openai:v0.11.0`, not `latest`) so a restart does not silently
  upgrade.
- **Port**: a random high port (the free port listed under "Where you are"), never the default
  8000/8080/30000. Publish to `127.0.0.1` unless other machines should reach it.
- **Weights in the models folder**: mount a subfolder of the machine's models folder (listed under
  "Where you are") into the container instead of a default cache, e.g.
  `-v <models>/huggingface:/root/.cache/huggingface`.
- **Start script**: write the compose file or `docker run` command as a script in the startup
  scripts folder (`start-<service>.sh`), and record the service in fleet.json: host, container name,
  image, port, models path, script.
- **Restart policy**: `--restart unless-stopped` (compose: `restart: unless-stopped`) for servers
  that should survive reboots. A start-full.sh that ai-bootstrap runs itself must instead stay in
  the foreground: `exec docker run --rm --name aib-full ...` without `-d`, or
  `exec docker compose -p aib-full up` (no `-d`), so ai-bootstrap can stop it on exit.
- **Health check**: give the container one (`HEALTHCHECK` / compose `healthcheck:` calling `/health`
  or `/v1/models`), so `docker ps` shows whether it is serving.

Example compose file (`<scripts>/aib-vllm-qwen3/compose.yaml`, started by `start-vllm-qwen3.sh` with
`docker compose -f <file> -p aib-vllm-qwen3 up -d`):

```yaml
services:
  server:
    image: vllm/vllm-openai:v0.11.0
    container_name: aib-vllm-qwen3
    restart: unless-stopped
    ipc: host
    ports: ["127.0.0.1:41873:41873"]
    volumes: ["/home/me/ai-bootstrap/models/huggingface:/root/.cache/huggingface"]
    command: ["--model", "Qwen/Qwen3-8B", "--port", "41873", "--max-model-len", "32768"]
    labels:
      ai-bootstrap.managed: "true"
      ai-bootstrap.service: vllm-qwen3
      ai-bootstrap.script: /home/me/ai-bootstrap/scripts/start-vllm-qwen3.sh
      ai-bootstrap.created: "2026-10-06"
    healthcheck:
      # Not every engine image has curl; python is in all the Python-based ones.
      test: [
        "CMD",
        "python3",
        "-c",
        "import urllib.request as u; u.urlopen('http://127.0.0.1:41873/health')",
      ]
      interval: 30s
    deploy:
      resources:
        reservations:
          devices: [{ driver: nvidia, count: all, capabilities: [gpu] }]
```

## Removing a service

1. `docker compose -p aib-<service> down` (or `docker rm -f aib-<service>`).
2. `docker image rm <image>` if nothing else uses it (`docker image ls` shows sizes).
3. Delete its start script, take it out of fleet.json, and remove its weights from the models folder
   only if the user agrees.

## An MCP server inside the container

Put a small MCP server in the service's container so ai-bootstrap (and other agents) can manage it
through tools instead of shell commands: is it healthy, which models does it serve, what are its
metrics, what does the GPU look like. Each service then carries its own management interface,
wherever it runs.

- Build a small image on top of the engine's image that adds the Python `mcp` package and a short
  server (FastMCP, streamable HTTP transport, served at `/mcp`).
- Start the MCP server in the background from the container's entry script, then `exec` the model
  server as before.
- Publish its port (another random high port) next to the model's, to `127.0.0.1` unless remote
  agents need it.
- Register it with `mcp_add` (url form: `http://<host>:<port>/mcp`) and note it in fleet.json.

Example (check the `mcp` package's documentation if its API has moved on):

```dockerfile
FROM vllm/vllm-openai:v0.11.0
RUN pip install --no-cache-dir mcp
COPY mcp_server.py entry.sh /opt/aib/
ENTRYPOINT ["sh", "/opt/aib/entry.sh"]
```

```sh
# entry.sh: the MCP server in the background, then the model server in the foreground.
python3 /opt/aib/mcp_server.py &
exec vllm serve "$@"
```

```python
# mcp_server.py: management tools for the model server in this container.
import json, os, subprocess, urllib.request
from mcp.server.fastmcp import FastMCP

PORT = int(os.environ.get("MODEL_PORT", "41873"))
mcp = FastMCP("aib-vllm-qwen3", host="0.0.0.0", port=int(os.environ.get("MCP_PORT", "41874")))

def get(path: str) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=5) as r:
        return r.read().decode()

@mcp.tool()
def health() -> str:
    """Whether the model server answers."""
    try:
        get("/health")
        return "healthy"
    except Exception as e:
        return f"not answering: {e}"

@mcp.tool()
def models() -> str:
    """The models this server serves."""
    return json.dumps([m["id"] for m in json.loads(get("/v1/models"))["data"]])

@mcp.tool()
def metrics() -> str:
    """Request and cache metrics (Prometheus text, vLLM/SGLang /metrics)."""
    return "\n".join(l for l in get("/metrics").splitlines() if not l.startswith("#"))[:8000]

@mcp.tool()
def gpu() -> str:
    """GPU memory and utilisation as the container sees it."""
    return subprocess.run(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                           "--format=csv"], capture_output=True, text=True).stdout

mcp.run(transport="streamable-http")
```

Pass `MODEL_PORT` and `MCP_PORT` as environment variables and publish both ports. Restarting or
removing the container stays a host-side job (`docker restart`, `docker compose down`); do not mount
the Docker socket into the container to make that possible, since that gives the container root on
the host.

## Install (Linux)

- Debian/Ubuntu/Fedora: Docker's convenience script `curl -fsSL https://get.docker.com | sh` (review
  it; ask the user), or the distribution packages (`docker.io` on Debian/Ubuntu, `moby-engine` on
  Fedora).
- Let the user run docker without sudo: `sudo usermod -aG docker $USER`, which takes effect at the
  next login. Until then use the sudo tool for docker commands.
- Check: `docker version`, `docker run --rm hello-world`.

macOS/Windows: Docker Desktop. Containers there cannot use the Mac GPU; on Windows, NVIDIA GPUs work
in Docker Desktop through WSL2.

## NVIDIA GPUs in containers

Needs a working host driver (`nvidia-smi`) and the NVIDIA Container Toolkit:

```sh
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
docker run --rm --gpus all ubuntu nvidia-smi
```

(RPM-based distros use the `.repo` file from the same site.)

## AMD GPUs in containers

`--device=/dev/kfd --device=/dev/dri --group-add video --security-opt seccomp=unconfined` with ROCm
images (`rocm/vllm`, `ghcr.io/ggml-org/llama.cpp:server-rocm`). Vulkan images need only
`--device=/dev/dri`.

## Running servers well

- `--ipc=host` (or a large `--shm-size`) for vLLM/SGLang.
- Logs: `docker logs -f <name>`; status: `docker ps`; GPU use: `nvidia-smi` on the host.
- Several services on one GPU: cap each one's memory (vLLM `--gpu-memory-utilization 0.45`) so they
  fit side by side.
