# Ollama

Easy local model runner built on llama.cpp, with its own model library. Linux, macOS, Windows.
NVIDIA, AMD (ROCm on supported Radeons), Apple Metal.

## Install

- Linux: `curl -fsSL https://ollama.com/install.sh | sh` (installs a systemd service `ollama`
  running as user `ollama`). Review scripts before piping to sh; ask the user.
- macOS / Windows: the app from ollama.com (or `brew install ollama`).
- Docker:
  `docker run -d --gpus all -v ollama:/root/.ollama -p 127.0.0.1:11434:11434 --name ollama ollama/ollama`.

## Use

```sh
ollama pull qwen3:30b-a3b          # names: ollama.com/library
ollama list ; ollama ps            # downloaded / loaded models
ollama run qwen3:8b "hello"
```

API on `http://127.0.0.1:11434`; the OpenAI-compatible base URL is `http://127.0.0.1:11434/v1`, and
the model id is the Ollama name (`qwen3:30b-a3b`). Tool calling works for models whose template
supports tools (Qwen3, gpt-oss, Llama 3.1+).

## Settings (environment variables)

| variable                      | meaning                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `OLLAMA_HOST=0.0.0.0:11434`   | listen on the network (no auth: firewall it)             |
| `OLLAMA_CONTEXT_LENGTH=32768` | default context (the default is small; agents need more) |
| `OLLAMA_MODELS=/path`         | where models are stored                                  |
| `OLLAMA_KEEP_ALIVE=30m`       | how long models stay loaded                              |
| `OLLAMA_FLASH_ATTENTION=1`    | flash attention                                          |

On Linux set them with `sudo systemctl edit ollama` → `[Service]` /
`Environment="OLLAMA_CONTEXT_LENGTH=32768"`, then `sudo systemctl restart ollama`. On macOS:
`launchctl setenv NAME value` and restart the app. On Windows: user environment variables, then
restart Ollama.

## Troubleshooting

- Runs on CPU unexpectedly: `ollama ps` shows the CPU/GPU split; check drivers and
  `journalctl -u ollama` for GPU detection lines.
- Tool calls ignored or truncated: raise the context length.
