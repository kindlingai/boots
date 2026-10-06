# llama.cpp (`llama-server`)

C/C++ inference for GGUF models. One binary, no Python. Backends: CUDA (NVIDIA), HIP/ROCm and Vulkan
(AMD), Metal (Apple, default on macOS), SYCL and Vulkan (Intel), CPU everywhere. ai-bootstrap's own
bootstrap model runs on it.

## Install

- Prebuilt releases: https://github.com/ggml-org/llama.cpp/releases. Asset names look like
  `llama-<tag>-bin-<platform>.<zip|tar.gz>`, e.g. `ubuntu-x64`, `ubuntu-arm64`, `ubuntu-vulkan-x64`,
  `macos-arm64`, `win-cpu-x64`, `win-cuda-12.4-x64` (+ `cudart-llama-bin-win-cuda-12.4-x64.zip`),
  `win-vulkan-x64`, `win-hip-*`. Linux CUDA builds are usually built from source or taken from
  Docker.
- Package managers: `brew install llama.cpp` (macOS/Linux), `winget install llama.cpp`.
- Docker: `ghcr.io/ggml-org/llama.cpp:server` (CPU), `:server-cuda`, `:server-vulkan`,
  `:server-rocm`.
- From source:
  ```sh
  git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
  cmake -B build -DGGML_CUDA=ON          # or -DGGML_VULKAN=ON, -DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1100
  cmake --build build --config Release -j
  ./build/bin/llama-server --version
  ```
  CUDA builds need the CUDA toolkit (`nvcc`); Vulkan builds need the Vulkan SDK/headers
  (`libvulkan-dev glslc` on Debian/Ubuntu).

Linux release tarballs ship shared libraries next to the binary; run it from that directory or set
`LD_LIBRARY_PATH` to it.

## Serve a model

```sh
llama-server -hf unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:Q4_K_M \
  --host 127.0.0.1 --port 8080 --jinja -c 32768 -ngl 999
```

| flag               | meaning                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `-hf repo[:quant]` | download from Hugging Face into `LLAMA_CACHE` (default `~/.cache/llama.cpp`, `~/Library/Caches/llama.cpp`) |
| `-m file.gguf`     | a local file instead                                                                                       |
| `--jinja`          | use the model's chat template; **needed for tool calls**                                                   |
| `-c N`             | context length; memory grows with it                                                                       |
| `-ngl N`           | layers on the GPU (`999` = all)                                                                            |
| `--n-cpu-moe N`    | keep the experts of the first N layers in system RAM (MoE models on small GPUs)                            |
| `-fa on`           | flash attention (spelled `-fa` alone in older builds)                                                      |
| `-np N`            | parallel slots; the context is split between them                                                          |
| `--api-key KEY`    | require `Authorization: Bearer KEY`                                                                        |
| `-t N`             | CPU threads                                                                                                |
| `--alias name`     | model id reported by `/v1/models`                                                                          |

Endpoints: `GET /health` (`{"status":"ok"}` once loaded), `GET /v1/models`,
`POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings` (with `--embeddings`).

Several GPUs: layers are split automatically; `--tensor-split 3,1` weights it, `-sm row` changes the
split mode. `CUDA_VISIBLE_DEVICES` picks GPUs.

## Quantizations

Q4_K_M is the usual balance; Q5_K_M/Q6_K/Q8_0 are better and bigger; IQ3/Q3 squeeze large models
into small memory with some quality loss. Unsloth's "UD" quants are good defaults. gpt-oss ships as
MXFP4.

## Troubleshooting

- `CUDA error: out of memory`: lower `-c`, use a smaller quant, or `--n-cpu-moe`.
- Tool calls arrive as plain text: start with `--jinja`, and use a model whose template supports
  tools.
- Slow on GPU: check the log for `offloaded N/N layers to GPU`; if 0, the build has no GPU backend
  or `-ngl` is missing.
- `-hf` download fails: no internet, Hugging Face blocked, or a gated repo (set `HF_TOKEN`).
