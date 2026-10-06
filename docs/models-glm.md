# GLM (Z.ai / Zhipu): open-weight models

GLM is a family of large mixture-of-experts (MoE) models, mostly MIT-licensed, strong at agentic
coding. Most of the line is datacenter-sized, but the Flash and Air models fit on a single big GPU
or a 128 GB unified-memory box. Checked October 2026. Entries marked (unconfirmed) could not be
verified at the source.

- Hugging Face org: https://huggingface.co/zai-org
- GitHub:
  - https://github.com/zai-org/GLM-5 (GLM-5.x)
  - https://github.com/zai-org/GLM-4.5 (GLM-4.5, 4.6, 4.7)
  - https://github.com/zai-org/GLM-V (vision models)
- Unsloth GGUF builds: `unsloth/GLM-4.5-Air-GGUF`, `unsloth/GLM-5-GGUF`, `unsloth/GLM-5.2-GGUF`,
  `unsloth/GLM-5.3-GGUF`, `unsloth/GLM-5.3-Flash-GGUF`

## Which one to run

| Machine (memory for the model)         | Pick                                                                                       | Notes                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 24-32 GB GPU or Mac                    | GLM-4.7-Flash (30B-A3B), Q4                                                                | one H100 at full precision                               |
| 128 GB unified (DGX Spark, Mac Studio) | GLM-4.5-Air (106B-A12B) Q4-Q8; GLM-5.3-Flash at UD-Q2_K_XL (109 GB) or UD-IQ3_XXS (120 GB) | ~17.7 tok/s reported for 5.3-Flash at 2-bit on one Spark |
| ~135 GB+                               | GLM-4.6 / 4.7 UD-Q2_K_XL (needs MoE offload)                                               | tight                                                    |
| 256 GB+ or 8 GPUs                      | GLM-5.x flagships (smallest quants ~240 GB)                                                | FP8: 8×H200                                              |

## GLM-5.3 and GLM-5.3-Flash (August 2026)

- **GLM-5.3** (announced 2026-08-14, weights 2026-08-28): post-trained on the GLM-5.2 base, 744B
  total / 40B active per the README. FP8 by default. 1M context (unconfirmed). License: custom
  (unconfirmed).
  - Links: https://huggingface.co/zai-org/GLM-5.3 · https://huggingface.co/zai-org/GLM-5.3-BF16
- **GLM-5.3-Flash** (2026-08-26): a new 320B-A18B base, the first natively multimodal GLM-5. Hybrid
  sparse + linear attention. 1M context. MIT (unconfirmed). FP8 weights are ~331 GB.
  - Links: https://huggingface.co/zai-org/GLM-5.3-Flash ·
    https://huggingface.co/zai-org/GLM-5.3-Flash-BF16 · `unsloth/GLM-5.3-Flash-GGUF`
  - llama.cpp support (text and vision) was merged on 2026-09-30 (PR #27773). Older builds cannot
    load it.
- "GLM-5.5" is only a rumour; nothing has been announced.

## GLM-5, 5.1 and 5.2 (February-June 2026)

- All 744B total / 40B active MoE with DeepSeek Sparse Attention. MIT.
- **GLM-5** (2026-02-12) and **GLM-5.1** (April 2026, long-horizon agentic coding): ~200K context.
- **GLM-5.2** (June 2026): adds IndexShare and multi-token prediction (MTP); 1M context (opt-in).
- Links: https://huggingface.co/zai-org/GLM-5 · https://huggingface.co/zai-org/GLM-5.1 ·
  https://huggingface.co/zai-org/GLM-5.2 · https://huggingface.co/zai-org/GLM-5.2-FP8 (FP8 variants
  of 5 and 5.1 also exist)
- Serving: the vLLM recipe for FP8 on 8×H200 adds `--speculative-config.method mtp`.

## GLM-4.5, 4.6 and 4.7 (July 2025-January 2026)

| Model         | Released | Size      | Context                           |
| ------------- | -------- | --------- | --------------------------------- |
| GLM-4.5       | 2025-07  | 355B-A32B | 128K                              |
| GLM-4.5-Air   | 2025-07  | 106B-A12B | 128K                              |
| GLM-4.6       | 2025-09  | 355B-A32B | 200K                              |
| GLM-4.7       | 2025-12  | 355B-A32B | 128K (README); ~200K at providers |
| GLM-4.7-Flash | 2026-01  | 30B-A3B   | ~200K (unconfirmed)               |

- MIT license.
- Links: https://huggingface.co/zai-org/GLM-4.7 · https://huggingface.co/zai-org/GLM-4.7-FP8 ·
  https://huggingface.co/zai-org/GLM-4.7-Flash · https://huggingface.co/zai-org/GLM-4.6 ·
  https://github.com/zai-org/GLM-4.5
- Official GPU counts: GLM-4.5 BF16 16×H100, FP8 8×H100; GLM-4.5-Air BF16 4×H100; GLM-4.7-Flash
  1×H100. Full context needs more.

## Vision models (GLM-V)

- `zai-org/GLM-4.6V`: 106B, 128K context (December 2025).
- `zai-org/GLM-4.6V-Flash`: 9B, 128K context. Fits a consumer GPU.
- `zai-org/GLM-4.5V` (2025-08-11) and `zai-org/GLM-4.1V-9B-Thinking` (64K context).
- GitHub: https://github.com/zai-org/GLM-V

## Serving

- vLLM:
  `vllm serve zai-org/GLM-4.7-FP8 --tensor-parallel-size 4 --enable-auto-tool-choice --tool-call-parser glm47 --reasoning-parser glm45`
- SGLang: the same parsers, `--tool-call-parser glm47 --reasoning-parser glm45`.
- GLM-4.5 and 4.6 use `glm45` for both parsers (unconfirmed).
- Thinking is on by default. Turn it off with the chat-template kwarg `{"enable_thinking": false}`;
  for llama.cpp, `--chat-template-kwargs '{"enable_thinking": false}'`.
- llama.cpp: use the unsloth GGUFs with `--jinja`.
