# DeepSeek: open-weight models

DeepSeek's flagships are large mixture-of-experts (MoE) models, all MIT-licensed. V4-Flash is the
smallest current flagship and needs ~110 GB+ even quantized; the full V4-Pro and the 671B V3 / R1
models need an 8-GPU node. The R1 distills run on one consumer GPU. Checked October 2026. Entries
marked (unconfirmed) could not be verified at the source.

- Hugging Face org: https://huggingface.co/deepseek-ai
- GitHub: https://github.com/deepseek-ai (model repos: DeepSeek-V3, DeepSeek-R1, DeepSeek-V3.2-Exp;
  kernels: FlashMLA, DeepGEMM, DeepEP). There is no V4 model repo.

## Which one to run

| Machine (memory for the model)                  | Pick                                           | Notes                                         |
| ----------------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| 8-24 GB GPU or Mac                              | an R1 distill (8B, 14B, 32B), Q4               | reasoning only; weaker at tools               |
| ~110-128 GB (DGX Spark, Mac Studio, Strix Halo) | DeepSeek-V4-Flash-0731 GGUF (~103 GB at 3-bit) | slow: ~6 tok/s generation reported on a Spark |
| 2×H200 / Blackwell                              | V4-Flash in native FP4+FP8 (~160 GB)           | FP4 needs Blackwell; H100 uses FP8 builds     |
| 8-GPU H200/B200 node                            | V4-Pro, V3.2, V3.1, R1                         |                                               |

## DeepSeek-V4 (April-August 2026)

- Hybrid attention (CSA + HCA) that needs ~10% of V3.2's KV cache at 1M context. FP4 experts with
  FP8 dense weights. 1M context, up to 384K output.
- Models:
  - **V4-Pro**: 1.6T total / 49B active. Preview 2026-04-24; **V4-Pro-0813** left preview on
    2026-08-13.
  - **V4-Flash**: 284B total / 13B active. Preview 2026-04-24; **V4-Flash-0731** (2026-07-31) is the
    official release and beats the Pro preview.
- Thinking modes: Non-Think, Think High and Think Max; thinking is on by default. Per request:
  `chat_template_kwargs: {"thinking": true}`; the API takes `reasoning_effort` `high` or `max`.
- Links: https://huggingface.co/collections/deepseek-ai/deepseek-v4 ·
  https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro ·
  https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash ·
  https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731 · `deepseek-ai/DeepSeek-V4-Pro-0813`
  (path unconfirmed)
- GGUF: https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF ·
  https://huggingface.co/unsloth/DeepSeek-V4-Flash-GGUF
- Serving:
  - vLLM and SGLang had launch-day recipes (FP4 MoE kernels, MTP speculative decoding). SGLang:
    `--reasoning-parser deepseek-v4`.
  - llama.cpp: supported since PR #24162 (merged 2026-06-29). Use a mainline build from July 2026 or
    later (a KV-cache quantization fix followed).
  - Ollama: `deepseek-v4-flash:cloud` is hosted, not local. Locally:
    `ollama run hf.co/ddh0/DeepSeek-V4-Flash-GGUF:Q4_0`.

## DeepSeek-V3.x (December 2024-December 2025)

All 671B total / 37B active (V3.2 is listed as 685B), MLA attention, 128K context (V3.2 ~160K).

| Model         | Released   | What changed                                   |
| ------------- | ---------- | ---------------------------------------------- |
| V3            | 2024-12    | base MoE, FP8 weights                          |
| V3-0324       | 2025-03    | post-training refresh                          |
| V3.1          | 2025-08    | one model with thinking and non-thinking modes |
| V3.1-Terminus | 2025-09    | fixes language mixing, better agents           |
| V3.2-Exp      | 2025-09-29 | first with DeepSeek Sparse Attention (DSA)     |
| V3.2          | 2025-12-01 | DSA stable; tool calls work inside thinking    |
| V3.2-Speciale | 2025-12-01 | high-compute, reasoning only                   |

- Links: https://huggingface.co/deepseek-ai/DeepSeek-V3.2 ·
  https://huggingface.co/deepseek-ai/DeepSeek-V3.2-Speciale ·
  https://huggingface.co/deepseek-ai/DeepSeek-V3.1-Terminus ·
  https://github.com/deepseek-ai/DeepSeek-V3 · https://github.com/deepseek-ai/DeepSeek-V3.2-Exp
- vLLM (official recipe; install DeepGEMM first):
  `vllm serve deepseek-ai/DeepSeek-V3.2 --tensor-parallel-size 8 --tokenizer-mode deepseek_v32 --tool-call-parser deepseek_v32 --enable-auto-tool-choice --reasoning-parser deepseek_v3`
  - The recipe prefers `-dp 8 --enable-expert-parallel`. With FlashMLA-Sparse, use TP=2 on Hopper
    and TP=1 on Blackwell rather than TP=8.

## DeepSeek-R1 and the distills (January-May 2025)

- **R1** (2025-01) and **R1-0528** (2025-05): 671B-A37B reasoning models, 128K context.
- Distills (MIT, plus the base model's license):
  - R1-Distill-Qwen-1.5B, -7B, -14B, -32B
  - R1-Distill-Llama-8B, -70B
  - R1-0528-Qwen3-8B (unconfirmed)
- Links: https://github.com/deepseek-ai/DeepSeek-R1 · https://huggingface.co/deepseek-ai/DeepSeek-R1
  · `deepseek-ai/DeepSeek-R1-Distill-Qwen-32B` (and the other distill names above)
- Sampling: temperature 0.6 (0.5-0.7), no system prompt, and start the output with `<think>\n`.
- Ollama: `deepseek-r1` (with the distill sizes as tags).
