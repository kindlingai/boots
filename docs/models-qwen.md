# Qwen (Alibaba): open-weight models

Qwen is the most common family for local agents: small dense models up to large mixtures of experts
(MoE), Apache-2.0 for most of them, with good tool calling. Checked October 2026. Entries marked
(unconfirmed) could not be verified at the source.

- Hugging Face org: https://huggingface.co/Qwen
- GitHub: https://github.com/QwenLM
- Unsloth GGUF builds: https://huggingface.co/unsloth (search for the model name)

## Which one to run

| Machine (memory for the model)                     | Pick                                                                                             | Notes                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------- |
| 8-16 GB GPU or Mac                                 | Qwen3.5-9B or Qwen3-8B, Q4                                                                       | ~6-7 GB at 4-bit     |
| 24 GB GPU, 32-36 GB Mac                            | Qwen3.8-27B or Qwen3.6-27B, Q4 (dense, ~17 GB); or Qwen3.6-35B-A3B Q3/Q4 (MoE, faster per token) | newest generations   |
| 48-64 GB                                           | Qwen3.6-35B-A3B Q8 (~38 GB), or Qwen3-Next-80B-A3B Q4                                            |                      |
| 128 GB unified (DGX Spark, Strix Halo, Mac Studio) | Qwen3.5-122B-A10B Q4, Qwen3-Coder-Next                                                           |                      |
| Multi-GPU servers                                  | Qwen3.5-397B-A17B, Qwen3-235B-A22B, Qwen3.8-2.4T-A95B                                            | BF16 397B is ~807 GB |

A mixture of experts (written `<total>B-A<active>B`) needs memory for every parameter, but each
token only computes the active ones, so it is much faster than a dense model of the same size. That
suits Apple silicon and unified-memory boxes, where memory bandwidth is the limit.

## Qwen3.8 (August 2026): open weights

- Multimodal (text, image, video); stronger long agentic tasks; adjustable reasoning depth.
- **Qwen3.8-27B** (2026-08-14): dense, Apache-2.0. Hybrid attention (16 of 64 layers full
  attention).
  - Context: 262,144 native, ~1M with YaRN.
  - Memory: Q4_K_M is 17.1 GB (fits a 24 GB GPU); UD-Q3_K_XL is 13.4 GB.
  - Links: https://huggingface.co/Qwen/Qwen3.8-27B · GGUF: `unsloth/Qwen3.8-27B-GGUF` (with a vision
    projector)
- **Qwen3.8-2.4T-A95B** (2026-08-12): the Max-class MoE, 2.4T total / 95B active.
  - The first Max-tier Qwen with downloadable weights. License: custom ("other" on Hugging Face;
    unconfirmed).
  - Memory: ~4.9 TB at full precision; the Unsloth 1-bit dynamic GGUF is ~397 GB.
  - Links: https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B ·
    https://huggingface.co/unsloth/Qwen3.8-2.4T-A95B-GGUF
- Collection: https://huggingface.co/collections/Qwen/qwen38 · GitHub:
  https://github.com/QwenLM/Qwen3.8
- Serving (official README):
  - vLLM:
    `vllm serve Qwen/Qwen3.8-27B --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_coder`
  - SGLang: `--reasoning-parser qwen3 --tool-call-parser qwen3_coder`
  - Thinking is controlled with chat-template kwargs: `{"enable_thinking": false}` turns it off;
    `{"reasoning_effort": "low|medium|high"}` sets the depth (default high).
  - llama.cpp: pass the same kwargs with `--chat-template-kwargs '{"enable_thinking": false}'`.
  - Ollama: `qwen3.8` (27B, ~18 GB with vision).

## Qwen3.7 (May-June 2026): API only

Qwen3.7-Max and Qwen3.7-Plus are proprietary (API, chat.qwen.ai, Model Studio). There are no open
weights: the open line went from 3.6 to 3.8.

## Qwen3.6 (April 2026)

- Focus on agentic coding; natively multimodal (text, image, video). Apache-2.0.
- Models:
  - **Qwen3.6-35B-A3B** (MoE, 2026-04-16)
  - **Qwen3.6-27B** (dense, 2026-04-22)
  - FP8 variants of both.
- Context: 262,144 native, ~1M with YaRN.
- Memory (Unsloth):

  | Model   | 3-bit | 4-bit | 8-bit | BF16  |
  | ------- | ----- | ----- | ----- | ----- |
  | 27B     | 14 GB | 17 GB | 30 GB | 54 GB |
  | 35B-A3B | 17 GB | 22 GB | 38 GB | 70 GB |

- Links: https://huggingface.co/collections/Qwen/qwen36 ·
  https://huggingface.co/Qwen/Qwen3.6-35B-A3B · https://huggingface.co/Qwen/Qwen3.6-27B ·
  https://github.com/QwenLM/Qwen3.6
- GGUF builds:
  - `unsloth/Qwen3.6-35B-A3B-GGUF`
  - `unsloth/Qwen3.6-27B-GGUF`
  - `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` (multi-token prediction, for faster decoding)
- Serving: vLLM >= 0.19 and SGLang >= 0.5.10 (secondary source). Ollama: `qwen3.6:27b` (17 GB),
  `qwen3.6:35b` (24 GB).

## Qwen3.5 (February-March 2026)

- Native multimodal (text + vision); hybrid linear-attention + sparse MoE. Apache-2.0. Context
  262,144.
- Models:
  - 397B-A17B (2026-02-16)
  - 122B-A10B and 35B-A3B (MoE), and 27B (dense) (2026-02-24)
  - 9B, 4B, 2B, 0.8B (2026-03-02)
  - Qwen3.5-Flash is API-only.
- Memory: 9B is ~6.5 GB at 4-bit, 13 GB at 8-bit.
- Links: https://huggingface.co/collections/Qwen/qwen35 · https://github.com/QwenLM/Qwen3.5 ·
  https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF · `unsloth/Qwen3.5-27B-GGUF`
- Serving:
  - llama.cpp: `-hf unsloth/Qwen3.5-35B-A3B-GGUF:UD-Q4_K_XL --jinja`. Thinking off:
    `--chat-template-kwargs '{"enable_thinking": false}'`. Vision needs the mmproj file.
  - Known issue: some `<think>` text can leak even with thinking off.
  - Ollama: `qwen3.5` (0.8b to 122b; default `qwen3.5:9b`, 6.6 GB).

## Qwen3-Next (September 2025)

- 80B-A3B hybrid architecture (Gated DeltaNet + gated attention, very sparse MoE), built for fast
  long context.
- Instruct and Thinking variants. Context 256K.
- Links: https://huggingface.co/Qwen/Qwen3-Next-80B-A3B-Instruct-GGUF (official GGUF) ·
  https://docs.unsloth.ai/models/qwen3-next
- Serving: vLLM and SGLang; llama.cpp through GGUF.

## Qwen3-Coder (July 2025; Coder-Next February 2026)

- Agentic coding models; the Instruct models never think.
- Models:
  - 480B-A35B-Instruct (262K context, 1M with YaRN)
  - 30B-A3B-Instruct (256K)
  - Qwen3-Coder-Next (Feb 2026, hybrid attention + MoE; 80B-A3B per secondary sources, unconfirmed)
- Links: https://github.com/QwenLM/Qwen3-Coder ·
  https://huggingface.co/unsloth/Qwen3-Coder-Next-GGUF
- Serving:
  - Tool calls need Qwen's parser: vLLM/SGLang `--tool-call-parser qwen3_coder`.
  - llama.cpp before 2026-02-04 looped on Coder-Next. Use a newer build; the Unsloth GGUFs were
    re-uploaded after the fix.

## Qwen3-VL (September-October 2025)

- Vision-language, Instruct and Thinking variants. Apache-2.0. 256K context (1M with YaRN).
- Sizes: dense 2B, 4B, 8B, 32B; MoE 30B-A3B and 235B-A22B.
- Links: https://github.com/QwenLM/Qwen3-VL
- Serving: vLLM >= 0.11, SGLang, Transformers >= 4.57.

## Qwen3 and the 2507 updates (April-August 2025)

- Qwen3 (2025-04-29): hybrid thinking / non-thinking. Apache-2.0.
  - Dense: 0.6B, 1.7B, 4B, 8B, 14B, 32B. MoE: 30B-A3B, 235B-A22B.
  - Switch modes with `enable_thinking=False`, or `/think` / `/no_think` in the prompt.
- 2507 updates (July-August 2025): separate Instruct (never thinks) and Thinking models.
  - Covers 235B-A22B, 30B-A3B and 4B. 256K native, 1M extendable.
  - ai-bootstrap uses `Qwen3-4B-Instruct-2507` as its bootstrap model and
    `Qwen3-30B-A3B-Instruct-2507` as its default full model.
- Links: https://github.com/QwenLM/Qwen3 · https://huggingface.co/collections/Qwen/qwen3 ·
  `Qwen/Qwen3-8B-GGUF` (official GGUF) · https://huggingface.co/unsloth/Qwen3-8B-GGUF
- Serving:
  - llama.cpp >= b5401: `--jinja` (add `--reasoning-format deepseek` to split out the thinking).
  - vLLM: `--reasoning-parser deepseek_r1` (or `qwen3` on newer versions);
    `--enable-auto-tool-choice --tool-call-parser hermes`.
  - SGLang: `--reasoning-parser qwen3`.
  - Ollama: `ollama run qwen3:8b` (`/set think`, `/set nothink`).

## Tips

- With llama.cpp, always pass `--jinja` so tool calls are parsed. Add `--reasoning off` (newer
  builds) or `--chat-template-kwargs '{"enable_thinking": false}'` when an agent should answer
  quickly.
- Unsloth's `UD-` quants (e.g. `UD-Q4_K_XL`) are dynamic quants. They are usually the best quality
  for their size.
