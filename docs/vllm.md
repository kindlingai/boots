# vLLM

High-throughput inference server (PagedAttention, continuous batching) with an OpenAI-compatible
API. Linux; NVIDIA first-class, AMD via ROCm builds, CPU and others experimental. On Windows use
WSL2; not for macOS GPUs.

## Install

Prefer Docker for repeatability:

```sh
docker run -d --name vllm --restart unless-stopped --gpus all --ipc=host \
  -p 127.0.0.1:8000:8000 -v ~/.cache/huggingface:/root/.cache/huggingface \
  -e HF_TOKEN \
  vllm/vllm-openai:latest \
  --model Qwen/Qwen3-30B-A3B-Instruct-2507-FP8 --max-model-len 32768 \
  --enable-auto-tool-choice --tool-call-parser hermes
```

Or in a virtualenv (needs a recent NVIDIA driver; the wheel brings CUDA/PyTorch):

```sh
python3 -m venv ~/.venvs/vllm && . ~/.venvs/vllm/bin/activate
pip install -U uv && uv pip install vllm --torch-backend=auto
vllm serve Qwen/Qwen3-30B-A3B-Instruct-2507-FP8 --host 127.0.0.1 --port 8000 \
  --max-model-len 32768 --gpu-memory-utilization 0.90 \
  --enable-auto-tool-choice --tool-call-parser hermes
```

AMD: use the ROCm images (`rocm/vllm:latest` or the tags in vLLM's ROCm docs) with
`--device=/dev/kfd --device=/dev/dri --group-add video --ipc=host`. DGX Spark / aarch64: use an
arm64 image that supports the GPU (NVIDIA's NGC `nvcr.io/nvidia/vllm`), not the x86 default.

## Key options

| option                                           | meaning                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `--max-model-len N`                              | context length; the most common fix for KV-cache OOM is lowering it                           |
| `--gpu-memory-utilization 0.9`                   | fraction of VRAM vLLM takes (leave room if the GPU is shared)                                 |
| `--tensor-parallel-size N` / `-tp N`             | split across N GPUs (same model of GPU)                                                       |
| `--enable-auto-tool-choice --tool-call-parser P` | tool calling: `hermes` for Qwen2.5/Qwen3, `openai` for gpt-oss, `llama3_json`, `mistral`, ... |
| `--reasoning-parser`                             | separates thinking from content (e.g. `qwen3`, `deepseek_r1`)                                 |
| `--quantization`                                 | usually detected from the checkpoint (FP8, AWQ, GPTQ)                                         |
| `--api-key KEY`                                  | require a bearer token                                                                        |
| `--served-model-name`                            | the id clients use                                                                            |

Endpoints: `GET /health`, `GET /v1/models`, `POST /v1/chat/completions`. Port 8000 by default.

## Choosing a checkpoint

- FP8 checkpoints need compute capability 8.9+ (RTX 40xx, L4/L40, H100, RTX 50xx, Blackwell).
- Ampere (RTX 30xx, A100, A10): use AWQ/GPTQ int4 or BF16.
- Memory ≈ weights + KV cache; vLLM pre-allocates `gpu-memory-utilization` of VRAM at start.
- GGUF support in vLLM is limited; use llama.cpp for GGUF.

## Troubleshooting

- `No available memory for the cache blocks` / OOM: lower `--max-model-len`, raise
  `--gpu-memory-utilization`, or pick a smaller/quantized model.
- `CUDA driver version is insufficient`: update the driver or use an older image tag.
- Gated models: `HF_TOKEN` must be set and the license accepted on huggingface.co.
- Shared memory errors in Docker: add `--ipc=host` (or `--shm-size 16g`).
- First start downloads the whole model; watch `docker logs -f vllm`.
