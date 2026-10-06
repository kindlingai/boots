# Intermediate model on Linux

Goal: replace the small CPU bootstrap model with a hardware-accelerated model that is good at tool
calling, served over an OpenAI-compatible API, then `use_model` it. Prefer this machine; otherwise a
box the user wants to set up.

## 1. Find out what the hardware is

```sh
uname -m; cat /etc/os-release | head -3
free -g; df -h ~ /var
lspci | grep -iE 'vga|3d|display'
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv   # NVIDIA
rocminfo | grep -E 'Marketing|gfx' ; rocm-smi --showmeminfo vram        # AMD (if ROCm installed)
ls /dev/kfd /dev/dri                                                   # AMD/Intel GPU device nodes
```

What matters: accelerator memory (VRAM, or the unified pool), CPU arch (x86_64 vs aarch64), driver
present or not, free disk (models are 5-70 GB), and whether Docker is installed.

## 2. Pick a model for the memory you have

Sizes are for 4-bit GGUF (Q4_K_M ≈ 0.6 bytes/parameter) plus room for the KV cache. Newer models
appear constantly: check what the user prefers, and prefer instruct models with good tool calling
(Qwen3 family, gpt-oss, GLM).

| accelerator memory       | good choices                                                                                 | server                       |
| ------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------- |
| 8 GB                     | Qwen3-8B Q4_K_M (~5 GB)                                                                      | llama.cpp, Ollama            |
| 12-16 GB                 | gpt-oss-20b (~13 GB, MXFP4); Qwen3-14B Q4 (~9 GB); Qwen3-30B-A3B Q4 with some experts on CPU | llama.cpp, Ollama            |
| 24 GB                    | Qwen3-30B-A3B-Instruct-2507 Q4_K_M (~19 GB); Qwen3-32B Q4 (~20 GB)                           | llama.cpp; vLLM with AWQ/FP8 |
| 48 GB                    | Qwen3-30B-A3B FP8, Qwen3-32B FP8                                                             | vLLM, SGLang                 |
| 80 GB+ or 128 GB unified | gpt-oss-120b (~63 GB); GLM-4.5-Air Q4 (~70 GB); Qwen3-235B-A22B Q3 (tight)                   | llama.cpp, vLLM, SGLang      |
| CPU only                 | Qwen3-30B-A3B Q4 (3B active, usable on fast DDR5); else stay on the 4B                       | llama.cpp                    |

Mixture-of-experts models (the `A3B` / `A22B` names, gpt-oss) run far faster than their total size
suggests, and llama.cpp can keep experts in system RAM (`--n-cpu-moe N`) when VRAM is short.

Choosing a server:

- **llama.cpp**: one binary, GGUF files, works on NVIDIA (CUDA), AMD (ROCm/HIP or Vulkan), Intel
  (Vulkan/SYCL) and CPU. Best default for one user. See docs/llama-cpp.
- **Ollama**: easiest install and model management; runs llama.cpp underneath. See docs/ollama.
- **vLLM / SGLang**: highest throughput, many concurrent users, safetensors/FP8/AWQ models; NVIDIA
  first, AMD via ROCm images. More moving parts. See docs/vllm, docs/sglang.

## 3. NVIDIA

Check the driver first: `nvidia-smi` must work. If it does not:

- Ubuntu: `sudo ubuntu-drivers install` (or `apt install nvidia-driver-570`-style packages; pick the
  version `ubuntu-drivers devices` recommends), then reboot. A reboot needs the user's explicit
  agreement.
- Secure Boot may block the module: `mokutil --sb-state`; the user must enroll a MOK.
- In containers, the NVIDIA Container Toolkit is needed (docs/docker).
- CUDA toolkit (`nvcc`) is only needed to _build_ things; prebuilt binaries and Docker images bring
  their own CUDA runtime, but need a new enough driver.

Compute capability matters for formats: FP8 needs Ada/Hopper/Blackwell (RTX 40xx, L4, L40, H100, RTX
50xx, GB10); older cards (RTX 30xx, A100) use AWQ/GPTQ in vLLM or GGUF in llama.cpp.

Multi-GPU: llama.cpp splits layers automatically; vLLM/SGLang use tensor parallelism
(`--tensor-parallel-size 2`), which wants identical GPUs.

### DGX Spark (and other GB10 / unified-memory NVIDIA systems)

- GB10 Grace Blackwell, **aarch64**, 128 GB unified LPDDR5x shared by CPU and GPU, DGX OS
  (Ubuntu-based) with the driver and CUDA preinstalled.
- `nvidia-smi` may not report a separate VRAM total; plan with the unified pool (leave ~16 GB for
  the OS).
- x86_64-only wheels and images will not run. Prefer NVIDIA's NGC containers (`nvcr.io/nvidia/vllm`,
  TensorRT-LLM) or arm64 builds that support the GPU's compute capability; generic
  `pip install vllm` may lag behind new GPUs.
- llama.cpp built with CUDA (`-DGGML_CUDA=ON`) and Ollama both run well; gpt-oss-120b and
  GLM-4.5-Air class models fit.
- Memory bandwidth (~270 GB/s) limits tokens/s on dense models; MoE models are the sweet spot.

## 4. AMD

- Discrete Radeon / Instinct: ROCm. Officially supported cards include RX 7900 XTX/XT (gfx1100),
  Radeon PRO W7900, MI200/MI300. Check `rocminfo`. Unsupported RDNA cards sometimes work with
  `HSA_OVERRIDE_GFX_VERSION` (e.g. `11.0.0` for other RDNA3 parts); treat that as experimental.
- The user must be in the `render` and `video` groups (`sudo usermod -aG render,video $USER`, then
  log out and in).
- llama.cpp with **Vulkan** (`-DGGML_VULKAN=ON`, or the `vulkan` release build) needs no ROCm at all
  and is often the quickest path; ROCm/HIP builds (`-DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1100`) can be
  faster for prompt processing.
- vLLM and SGLang on AMD: use the ROCm Docker images (`rocm/vllm`, `lmsysorg/sglang:*-rocm*`), with
  `--device=/dev/kfd --device=/dev/dri --group-add video`.

### AMD unified memory (Strix Halo: Ryzen AI Max / Max+, e.g. 395 with 128 GB)

- GPU is gfx1151 sharing system RAM. Out of the box only the BIOS "UMA frame buffer" is reserved as
  VRAM; the rest is reachable as GTT.
- Either raise the dedicated VRAM in the BIOS, or let the driver map more GTT with kernel parameters
  such as `amdgpu.gttsize=...` / `ttm.pages_limit=...` (values in MiB / 4 KiB pages; check current
  guidance for the kernel in use). Changing kernel parameters or BIOS settings needs the user's
  agreement and a reboot.
- Use a recent kernel (6.11+) and Mesa. llama.cpp's Vulkan backend works well; ROCm support for
  gfx1151 needs a recent ROCm (6.4.x/7.x).
- 128 GB systems fit gpt-oss-120b and GLM-4.5-Air class MoE models.

## 5. Intel GPUs

Arc / Battlemage: llama.cpp with Vulkan or SYCL, or Ollama's Intel builds (ipex-llm). Expect less
maturity than NVIDIA/AMD.

## 6. Run it, verify it, switch

1. Start the server bound to `127.0.0.1` unless other machines need it; if it must listen on the
   network, set an API key (`--api-key` in llama.cpp / vLLM).
2. Make it survive reboots: a systemd unit or a Docker container with `--restart unless-stopped`.
3. Verify: `curl -s localhost:PORT/v1/models`, then a tool-calling request.
4. `use_model` with the base URL and model id; the bootstrap model stays as fallback.
5. Record in memory: machine, GPU, server, model, port, how it is started.

Things that commonly go wrong: wrong driver/CUDA combination, not enough memory for the context
length (lower it), port already taken (`ss -ltnp`), disk full during download (`df -h`, HF cache is
`~/.cache/huggingface`), gated Hugging Face models (need `HF_TOKEN`), firewall blocking remote
access.
