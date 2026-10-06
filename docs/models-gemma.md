# Gemma and DiffusionGemma (Google DeepMind): open-weight models

Gemma is Google's open family: small to mid-size models that run well on a laptop or a single GPU.
Gemma 4 is Apache-2.0 (earlier generations use the Gemma Terms of Use). DiffusionGemma is an
experimental Gemma 4 variant that generates text by diffusion. Checked October 2026. Entries marked
(unconfirmed) could not be verified at the source.

- Hugging Face org: https://huggingface.co/google
- GitHub: https://github.com/google-deepmind/gemma (JAX library) ·
  https://github.com/google-gemma/awesome-gemma
- Official llama.cpp GGUFs: https://huggingface.co/collections/ggml-org/gemma-4

## Which one to run

| Machine (memory for the model) | Pick                                                            | Notes |
| ------------------------------ | --------------------------------------------------------------- | ----- |
| Phone, 8 GB laptop             | Gemma 4 E2B or E4B (QAT mobile builds 2.7 / 3.7 GB)             |       |
| 16 GB laptop or GPU            | Gemma 4 E4B, or Gemma 4 12B at 4-bit                            |       |
| 24 GB GPU, 32 GB Mac           | Gemma 4 26B-A4B (MoE, fast) or 31B (dense), 4-bit (unconfirmed) |       |
| 80 GB GPU                      | 26B-A4B or 31B unquantized                                      |       |

## Gemma 4 (April-June 2026)

- Thinking mode, native function calling, text + image + audio input, 140+ languages. Apache-2.0.
- Released 2026-03-31 per Google's release notes (widely reported as 2026-04-02).

  | Model                      | Size                                                 | Context       |
  | -------------------------- | ---------------------------------------------------- | ------------- |
  | E2B                        | 2.3B effective / 5.1B total                          | 128K          |
  | E4B                        | 4.5B effective / 8B total                            | 128K          |
  | 12B "Unified" (2026-06-03) | 12B; image and audio patches go straight into the LM | (unconfirmed) |
  | 26B-A4B                    | MoE, 25.2B total / 3.8B active                       | 256K          |
  | 31B                        | dense                                                | 256K          |

- Links: https://huggingface.co/collections/google/gemma-4 ·
  https://huggingface.co/collections/google/gemma-4-qat-q4-0
  - Instruct models: `google/gemma-4-E2B-it`, `-E4B-it`, `-12B-it`, `-26B-A4B-it`, `-31B-it`
  - Speculative-decoding drafts: `google/gemma-4-<size>-it-assistant`
  - QAT 4-bit: `google/gemma-4-<size>-it-qat-w4a16-ct`; mobile:
    `google/gemma-4-E2B-it-qat-mobile-ct`, `google/gemma-4-E4B-it-qat-mobile-ct`
  - GGUF: `ggml-org` collection above, https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF
- Serving:
  - vLLM (nightly):
    `vllm serve google/gemma-4-31B-it --reasoning-parser gemma4 --tool-call-parser gemma4 --enable-auto-tool-choice --chat-template examples/tool_chat_template_gemma4.jinja`
    - Speculative decoding:
      `--speculative-config '{"model":"google/gemma-4-31B-it-assistant","num_speculative_tokens":4}'`
    - Unquantized memory: E2B/E4B 24 GB, 12B 40 GB, 26B-A4B and 31B 80 GB.
  - Thinking: put `<|think|>` at the start of the system prompt; thoughts come back wrapped in
    `<|channel>thought ... <channel|>`. llama-server:
    `--chat-template-kwargs '{"enable_thinking":false}'` to turn it off.
  - llama.cpp: use `--jinja`.
  - Ollama: `gemma4:e2b`, `gemma4:e4b` (default), `:12b`, `:26b`, `:31b` (unconfirmed).

## DiffusionGemma (June 2026)

- An experimental text model that generates by discrete diffusion: each step refines a 256-token
  block in parallel instead of producing one token at a time. Released 2026-06-10, Apache-2.0, up to
  256K context. Input: text, image, video; output: text.
- Built on Gemma 4 26B-A4B (25.2B total / 3.8B active). Only the instruct model exists.
- Much faster, somewhat weaker: over 1,000 tok/s on one H100 and ~700 tok/s on an RTX 5090 (up to 4×
  Gemma 4), but lower scores (MMLU-Pro 77.6 vs 82.6; AIME-2026 69.1 vs 88.3).
- Links: https://huggingface.co/collections/google/diffusiongemma ·
  `google/diffusiongemma-26B-A4B-it`
  - Quantized: https://huggingface.co/unsloth/diffusiongemma-26B-A4B-it-GGUF ·
    https://huggingface.co/nvidia/diffusiongemma-26B-A4B-it-NVFP4 ·
    https://huggingface.co/EigenLabs/DiffusionGemma-26B-A4B-it-MLX-4bit
- Serving:
  - vLLM supports it natively: keep `--max-num-seqs` at 4 or lower and pass
    `--generation-config vllm`.
  - SGLang, Transformers and MLX also support it.
  - llama.cpp: **not in mainline**. PRs #24423 and #24427 are still open; build from the PR branch
    (`-n` sets the output length).
  - Ollama: no library model; only a custom GGUF import.
- Not the same as Gemini Diffusion, which is API only.

## Gemma 3 and 3n (2025)

- **Gemma 3** (2025-03-10): 1B, 4B, 12B, 27B (4B and up take images). 128K context (1B: 32K). Gemma
  3 270M followed on 2025-08-14.
- **Gemma 3n** (2025-06-26): E2B and E4B for phones and edge devices; text, image and audio input;
  32K context.
- License: Gemma Terms of Use.
- Links (unconfirmed names): `google/gemma-3-27b-it`, `google/gemma-3-27b-it-qat-q4_0-gguf`,
  `google/gemma-3n-E4B-it`

## Specialised variants

- EmbeddingGemma 308M (2025-09): embeddings, 100+ languages.
- MedGemma 4B and 27B (2025), MedGemma 1.5 4B (2026-01): medical text and imaging.
  https://huggingface.co/collections/google/medgemma-release
- TranslateGemma 4B / 12B / 27B (2026-01): 55 languages.
- FunctionGemma 270M (2025-12): small function-calling model.
- Also PaliGemma 2, ShieldGemma, RecurrentGemma, CodeGemma (2024, not updated). Licenses vary.
