# Kimi (Moonshot AI): open-weight models

Kimi's flagships are trillion-parameter mixture-of-experts (MoE) models built for agentic work and
tool use. None of K2, K2.5, K2.6 or K3 fits on one machine with 128 GB or less; they need a
multi-GPU server or several hundred GB of RAM. The small Kimi-Linear and Kimi-VL models do run
locally. Checked October 2026. Entries marked (unconfirmed) could not be verified at the source.

- Hugging Face org: https://huggingface.co/moonshotai
- GitHub:
  - https://github.com/MoonshotAI/Kimi-K3
  - https://github.com/MoonshotAI/Kimi-K2.5
  - https://github.com/MoonshotAI/Kimi-K2
  - https://github.com/MoonshotAI/Kimi-Linear
  - https://github.com/MoonshotAI/Kimi-VL
- Unsloth GGUF builds exist for K2.5, K2.6 and K3 (e.g. `unsloth/Kimi-K3-GGUF`).

## Models

| Model                                 | Released                           | Size                                                              | Context            | License                                                    |
| ------------------------------------- | ---------------------------------- | ----------------------------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| Kimi K3                               | API 2026-07-16, weights 2026-07-27 | 2.8T-A104B, 896 experts (16 active); native vision; MXFP4 weights | 1M                 | Kimi K3 License (custom; extra terms above US$20M revenue) |
| Kimi K2.6                             | 2026-04 (unconfirmed)              | 1T-A32B; image and video input                                    | 256K               | Modified MIT (unconfirmed)                                 |
| Kimi K2.5                             | 2026-01-27                         | 1T-A32B; MoonViT vision encoder; native INT4                      | 256K               | Modified MIT                                               |
| Kimi-K2-Thinking                      | 2025-11-06                         | 1T-A32B reasoning; native INT4 (~594 GB)                          | 256K               | Modified MIT                                               |
| Kimi-K2-Instruct-0905                 | 2025-09                            | 1T-A32B                                                           | 256K (unconfirmed) | Modified MIT                                               |
| Kimi-K2-Base / -Instruct              | 2025-07                            | 1T-A32B, 384 experts                                              | 128K               | Modified MIT                                               |
| Kimi-Linear-48B-A3B (Base / Instruct) | ~2025-10-30                        | 48B-A3B, Kimi Delta Attention (linear) + MLA                      | 1M                 | MIT (unconfirmed)                                          |
| Kimi-VL-A3B (Instruct, Thinking-2506) | 2025-04 / 06                       | 16B-A3B vision-language                                           | 128K               |                                                            |

Hugging Face pages:

- https://huggingface.co/moonshotai/Kimi-K3
- https://huggingface.co/moonshotai/Kimi-K2.6 · https://huggingface.co/moonshotai/Kimi-K2.5
- https://huggingface.co/moonshotai/Kimi-K2-Thinking ·
  https://huggingface.co/moonshotai/Kimi-K2-Instruct ·
  https://huggingface.co/moonshotai/Kimi-K2-Instruct-0905 (the K2.5 and K2 Instruct names are the
  standard ones; not individually checked)
- https://huggingface.co/moonshotai/Kimi-Linear-48B-A3B-Instruct
- https://huggingface.co/moonshotai/Kimi-VL-A3B-Instruct ·
  https://huggingface.co/moonshotai/Kimi-VL-A3B-Thinking-2506

## Memory

| Model               | Smallest practical build | Needs                                        |
| ------------------- | ------------------------ | -------------------------------------------- |
| K3                  | UD-IQ1_S GGUF, 594 GB    | 610 GB+ RAM; or an 8×B300 node (unconfirmed) |
| K2.6                | UD-Q2_K_XL GGUF          | 350 GB+ RAM; INT4 on 8×H200 (~640 GB)        |
| K2.5                | UD-TQ1_0 GGUF, ~240 GB   | 8×H200 for INT4                              |
| K2 / K2-0905        | FP8                      | 16×H200/H20 (two nodes) at 128K              |
| Kimi-Linear-48B-A3B | Q4                       | fits a 32-48 GB GPU or Mac                   |
| Kimi-VL-A3B         | BF16                     | fits a 24-32 GB GPU                          |

## Serving

- vLLM / SGLang tool and reasoning parsers:
  - K2 and K2-0905: `--enable-auto-tool-choice --tool-call-parser kimi_k2`
  - K2-Thinking, K2.5, K2.6: `--tool-call-parser kimi_k2 --reasoning-parser kimi_k2`
  - K3:
    `--trust-remote-code --enable-auto-tool-choice --tool-call-parser kimi_k3 --reasoning-parser kimi_k3`.
    Thinking is always on.
- K2.5 official example (8×H200):
  `vllm serve moonshotai/Kimi-K2.5 -tp 8 --mm-encoder-tp-mode data --trust-remote-code --tool-call-parser kimi_k2 --reasoning-parser kimi_k2`
- Kimi-Linear:
  `vllm serve moonshotai/Kimi-Linear-48B-A3B-Instruct --tensor-parallel-size 4 --max-model-len 1048576 --trust-remote-code`
- llama.cpp: K3 text support was merged on 2026-08-15 (PR #26185); K3 vision still needs unsloth's
  fork. Use `--jinja`.
