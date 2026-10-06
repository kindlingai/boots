# Intermediate model on macOS

Goal: run a Metal-accelerated model with good tool calling behind an OpenAI-compatible API, then
`use_model` it.

## 1. Check the machine

```sh
sw_vers; uname -m                       # arm64 = Apple Silicon, x86_64 = Intel
sysctl -n machdep.cpu.brand_string      # e.g. Apple M3 Max
sysctl -n hw.memsize                    # bytes of unified memory
df -h ~
command -v brew ollama llama-server lms
```

Intel Macs have no useful GPU acceleration for this; stay on CPU models or use another machine.

## 2. How much memory the GPU can use

Apple Silicon shares one memory pool. By default macOS lets the GPU wire roughly 65-75% of RAM. On
macOS 14+ the limit can be raised until reboot:

```sh
sudo sysctl iogpu.wired_limit_mb=<MB>   # e.g. 57344 on a 64 GB Mac; leave 8+ GB for macOS
```

Ask before changing it; it resets at reboot.

## 3. Pick a model

| unified memory | good choices (4-bit)                                                   |
| -------------- | ---------------------------------------------------------------------- |
| 16 GB          | Qwen3-8B (~5 GB), gpt-oss-20b (~13 GB, tight)                          |
| 24-36 GB       | gpt-oss-20b; Qwen3-14B; Qwen3-30B-A3B-Instruct-2507 (~19 GB) on 32 GB+ |
| 48-64 GB       | Qwen3-30B-A3B at higher precision (Q6/Q8); Qwen3-32B                   |
| 96-128 GB      | gpt-oss-120b (~63 GB); GLM-4.5-Air (~70 GB)                            |
| 192 GB+        | Qwen3-235B-A22B (Q4 ~130 GB)                                           |

Mixture-of-experts models (A3B, gpt-oss) are much faster than dense ones of the same size, since
memory bandwidth limits generation speed.

## 4. Servers

### llama.cpp (recommended: reliable tool calling)

```sh
brew install llama.cpp        # or the macos-arm64 release from GitHub
llama-server -hf unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:Q4_K_M \
  --host 127.0.0.1 --port 8080 --jinja -c 32768 -ngl 999
```

Metal is used automatically. Model files land in `~/Library/Caches/llama.cpp`. See docs/llama-cpp.

### Ollama

Install the app from ollama.com, or `brew install ollama` then `ollama serve`.
`ollama pull qwen3:30b-a3b`; OpenAI API at `http://127.0.0.1:11434/v1`. Raise the context with
`OLLAMA_CONTEXT_LENGTH=32768` (for the app: `launchctl setenv`, then restart it). See docs/ollama.

### MLX (`mlx-lm`)

Apple's MLX framework is often the fastest on Apple Silicon.

```sh
python3 -m venv ~/.venvs/mlx && ~/.venvs/mlx/bin/pip install mlx-lm
~/.venvs/mlx/bin/mlx_lm.server --model mlx-community/Qwen3-30B-A3B-4bit --host 127.0.0.1 --port 8081
```

It serves `/v1/chat/completions`. Tool-call support depends on the mlx-lm version and the model's
chat template: test a tool call before switching to it.

### LM Studio

A GUI app with a local server (default port 1234, OpenAI-compatible) and a `lms` CLI
(`lms server start`, `lms load <model>`). It can run GGUF (llama.cpp) and MLX models. Good when the
user prefers a GUI.

## 5. Keep it running

- Ollama and LM Studio run as apps or login items.
- For llama-server, a LaunchAgent (`~/Library/LaunchAgents/<name>.plist` with `RunAtLoad` and
  `KeepAlive`, loaded with `launchctl bootstrap gui/$(id -u) <plist>`) keeps it up across logins.

## 6. Verify and switch

`curl -s localhost:PORT/v1/models`, try a tool-calling request, then `use_model`. Save the model,
port and start method to memory.

Things that go wrong: the model needs more memory than the GPU wired limit (swapping makes it crawl:
pick a smaller quant or raise the limit), the Mac sleeps (use `caffeinate -s` or Energy settings for
a server), Gatekeeper quarantine on downloaded binaries (`xattr -dr com.apple.quarantine <dir>`,
with the user's OK).
