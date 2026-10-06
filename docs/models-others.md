# Other open-weight model families: gpt-oss, Meta, Mistral, MiniMax, Nemotron, Phi, Granite, OLMo

Families beyond Qwen, GLM, Kimi, DeepSeek and Gemma (each of those has its own models-* doc).
Checked October 2026. Links were found through search indexes rather than opened directly; entries
marked (unconfirmed) came from a single secondary source.

## Quick picks for local machines

| Memory for the model         | Options                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 8-16 GB                      | gpt-oss-20b (~16 GB), Granite 4.2 8B, Phi-4 / Phi-4-mini, Olmo 3 7B                                           |
| 24 GB GPU, 32 GB Mac         | Muse Glimmer 30B Q4 (~17 GB), Nemotron 3 Nano 30B-A3B Q4, Granite 4.2 30B Q4 (estimate), Devstral Small 2 24B |
| 80 GB GPU, 96-128 GB unified | gpt-oss-120b (one 80 GB GPU), Nemotron 3 Super 120B-A12B Q4, Mistral Small 4 119B Q4, Llama 4 Scout           |
| 8-GPU node                   | MiniMax-M3, Nemotron 3 Ultra, Mistral Large 3, Mistral Medium 3.5 (~4 GPUs)                                   |

## OpenAI gpt-oss (August 2025)

- **gpt-oss-120b**: MoE, 117B total / 5.1B active; fits one 80 GB GPU.
- **gpt-oss-20b**: 21B / 3.6B active; runs in about 16 GB.
- **gpt-oss-safeguard-120b / -20b** (October 2025): classify text against a policy you supply.
- 128K context. Apache-2.0. Weights ship natively in MXFP4.
- Links: https://huggingface.co/openai/gpt-oss-120b · https://huggingface.co/openai/gpt-oss-20b ·
  https://huggingface.co/collections/openai/gpt-oss · https://github.com/openai/gpt-oss ·
  https://github.com/openai/harmony
- GGUF: https://huggingface.co/ggml-org/gpt-oss-20b-GGUF · `unsloth/gpt-oss-20b-GGUF` ·
  `unsloth/gpt-oss-120b-GGUF`
- Serving: the models must use the **harmony** response format (separate channels for reasoning,
  tool calls and the answer). llama.cpp: `--jinja` uses the embedded template. Reasoning effort low
  / medium / high is set in the system prompt or chat-template kwargs. vLLM, Ollama (`gpt-oss:20b`,
  `gpt-oss:120b`) and LM Studio support it.
- Claims of newer gpt-oss sizes in 2026 could not be confirmed.

## Meta: Llama 4 and Muse Glimmer

- **Llama 4 Scout / Maverick** (April 2025): natively multimodal MoE. Llama 4 Community License
  (gated).
  - Scout: 109B total / 17B active, 10M context.
  - Maverick: 400B / 17B active, 1M context.
  - Links: https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct ·
    https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8
  - There is no Llama 5, and Behemoth was never released.
- **Muse Glimmer 30B** (2026-08-10): Meta's first open model since Llama 4. Dense ~30B plus an image
  encoder, tuned for agents. 128K context (262K extended). **Apache-2.0**, ungated.
  - Links: https://huggingface.co/meta-models/Muse-Glimmer-30B ·
    https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF (official GGUF) ·
    `unsloth/Muse-Glimmer-30B-GGUF`
  - llama.cpp: Q4_K_M ~16.8 GB (fits 24 GB); images need the mmproj file (~1.4 GB).
  - vLLM: `muse_glimmer` tool and reasoning parsers. Ollama: `muse-glimmer`.

## Mistral AI

- Org: https://huggingface.co/mistralai
- **Mistral Small 4** (March 2026): MoE, 119B total / ~6.5B active; text + image; 256K; Apache-2.0.
  Replaces Magistral, Pixtral and Devstral as one model; per-request `reasoning_effort` (`none` /
  `high`).
  - Links: https://huggingface.co/mistralai/Mistral-Small-4-119B-2603 ·
    https://huggingface.co/collections/mistralai/mistral-small-4 ·
    `unsloth/Mistral-Small-4-119B-2603-GGUF`
- **Mistral Medium 3.5** (April 2026): dense 128B, instruct + reasoning + coding, image input, 256K.
  Modified MIT (revenue cap).
  - Links: https://huggingface.co/mistralai/Mistral-Medium-3.5-128B ·
    `unsloth/Mistral-Medium-3.5-128B-GGUF`
- **Devstral 2** (December 2025): coding, 256K. `mistralai/Devstral-2-123B-Instruct-2512` and
  `mistralai/Devstral-Small-2-24B-Instruct-2512` (fits one 24-32 GB GPU at 4-bit).
- **Mistral Large 3** (December 2025): ~675B / 41B active MoE.
- **Mistral Large 4** (~1T MoE) is API preview only; weights are expected late October 2026.

## MiniMax

- Org: https://huggingface.co/MiniMaxAI · GitHub: https://github.com/MiniMax-AI/MiniMax-M3
- **MiniMax-M2.5** (February 2026): MoE 230B / 10B active, ~196K context, Modified MIT.
  https://huggingface.co/MiniMaxAI/MiniMax-M2.5
- **MiniMax-M2.7** (April 2026): same shape; free use is non-commercial only.
  https://huggingface.co/MiniMaxAI/MiniMax-M2.7
- **MiniMax-M3** (2026-06-01): multimodal MoE ~428B / ~22B active, MiniMax Sparse Attention, up to
  1M context (unconfirmed). MiniMax Community License.
  - Links: https://huggingface.co/MiniMaxAI/MiniMax-M3 · `MiniMaxAI/MiniMax-M3-MXFP8` ·
    `unsloth/MiniMax-M3-GGUF`
  - SGLang (official, TP8) and vLLM. llama.cpp support is preliminary. MXFP8 is ~440 GB.

## NVIDIA Nemotron 3

- Hybrid Mamba-Transformer MoE, 1M context. Org: https://huggingface.co/nvidia
- **Nano 30B-A3B** (December 2025): NVIDIA Open Model License. GGUF:
  `unsloth/Nemotron-3-Nano-30B-A3B-GGUF`. Omni variant:
  `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16`.
- **Super 120B-A12B** (2026-03-11): `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16` (also FP8,
  NVFP4); GGUF `unsloth/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF`.
- **Ultra 550B-A55B** (2026-06-04): `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16`. NVFP4 needs
  4×B200 or 8×H100. License OpenMDW-1.1 (unconfirmed).

## Microsoft Phi

- No Phi-5. Latest: **Phi-4-reasoning-vision-15B** (2026-03-04), 16K context, MIT.
  https://huggingface.co/microsoft/Phi-4-reasoning-vision-15B
- Earlier (2025, MIT): Phi-4 (14B), Phi-4-mini (3.8B), Phi-4-multimodal (5.6B), Phi-4-reasoning
  (14B).

## IBM Granite

- Org: https://huggingface.co/ibm-granite
- **Granite 4.2** (2026-08-25): dense 3B, 8B, 30B with thinking on / off / low and native tool
  calling. 128K context (512K extended). Apache-2.0. Official GGUFs:
  https://huggingface.co/ibm-granite/granite-4.2-8b-GGUF · `ibm-granite/granite-4.2-30b-GGUF` ·
  `ibm-granite/granite-4.2-3b-GGUF` · collection
  https://huggingface.co/collections/ibm-granite/granite-42-language-models
- **Granite 4.1** (2026-04-29): 3B, 8B, 30B plus Vision, Speech and Code variants; 512K; Apache-2.0.

## AllenAI OLMo (fully open: data and training recipes)

- Org: https://huggingface.co/allenai · GitHub: https://github.com/allenai/OLMo-core
- **Olmo 3** (November 2025): dense 7B and 32B, Base / Instruct / Think, 65K context, Apache-2.0.
- **Olmo 3.1** (December 2025): https://huggingface.co/allenai/Olmo-3.1-32B-Think ·
  https://huggingface.co/allenai/Olmo-3.1-32B-Instruct
- **Olmo Hybrid 7B** (March 2026): attention + Gated DeltaNet layers; needs transformers >= 5.3.
  https://huggingface.co/allenai/Olmo-Hybrid-7B
