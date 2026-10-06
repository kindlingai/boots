# SGLang

Fast serving framework (RadixAttention prefix caching, structured outputs) with an OpenAI-compatible
API. Linux; NVIDIA and AMD (ROCm). On Windows use WSL2.

## Install

Docker:

```sh
docker run -d --name sglang --restart unless-stopped --gpus all --ipc=host \
  -p 127.0.0.1:30000:30000 -v ~/.cache/huggingface:/root/.cache/huggingface -e HF_TOKEN \
  lmsysorg/sglang:latest \
  python3 -m sglang.launch_server --model-path Qwen/Qwen3-30B-A3B-Instruct-2507 \
    --host 0.0.0.0 --port 30000 --context-length 32768 --tool-call-parser qwen25
```

(The container listens on 0.0.0.0 inside; the `-p 127.0.0.1:` mapping keeps it local.) AMD: use the
ROCm-tagged `lmsysorg/sglang` images with `--device=/dev/kfd --device=/dev/dri --group-add video`.

pip:

```sh
python3 -m venv ~/.venvs/sglang && . ~/.venvs/sglang/bin/activate
pip install -U uv && uv pip install "sglang[all]"
python -m sglang.launch_server --model-path <model> --host 127.0.0.1 --port 30000
```

## Key options

| option                       | meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `--model-path`               | Hugging Face id or local directory                            |
| `--tp N`                     | tensor parallelism across N GPUs                              |
| `--context-length N`         | maximum context                                               |
| `--mem-fraction-static 0.85` | share of VRAM for weights + KV cache; lower it on OOM         |
| `--tool-call-parser`         | `qwen25` (Qwen2.5/Qwen3), `llama3`, `mistral`, `gpt-oss`, ... |
| `--reasoning-parser`         | e.g. `qwen3`                                                  |
| `--api-key`                  | require a bearer token                                        |
| `--quantization fp8`         | online FP8 on supported GPUs                                  |

Endpoints: `GET /health`, `GET /v1/models`, `POST /v1/chat/completions`. Port 30000 by default.

## Troubleshooting

- OOM at start: lower `--mem-fraction-static` or `--context-length`.
- Hangs during CUDA graph capture on small GPUs: `--disable-cuda-graph` to test.
- Same FP8/compute-capability and gated-model notes as docs/vllm.
