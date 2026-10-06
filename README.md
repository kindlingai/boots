# ai-bootstrap

_🧠 human written docs_

A single, offline-friendly binary that you can use to bootstrap your local AI.

## Usage

Easy.

`ai-bootstrap` - boots the program, discovers any bootstrap intelligence that it can use and
starts the prompt loop to understand what you'd like to do. If it doesn't find a bootstrap
intelligence, it'll prompt you to download a small Qwen 4B model to start.

Once the small Qwen model is installed, `ai-bootstrap` will try to get a more intelligent,
hardware-accelerated model up and running somewhere, based on your local hardware's capability and your
guidance. You can run the intermediate model locally (recommended), or it can find some room on
the machines you want to configure themselves.

Some other ways to get started:

 - `OPENROUTER_API_KEY=xxx ai-bootstrap`: Use a free model from OpenRouter as your bootstrap intelligence
 - `OPENAI_API_KEY=xxx ai-bootstrap`: Use an OpenAI model as your bootstrap intelligence
 - `OPENAI_BASE_URL=https://... OPENAI_API_KEY=xxx OPENAI_MODEL=xxx ai-bootstrap`: Use an OpenAI-compatible model as your bootstrap intelligence

## What it knows

`ai-bootstrap` ships will a small knowledge-base of common LLM servers:

 - llama
 - vLLM
 - sglang
 - Tensorfold

 It also ships with knowledge of how to configure LLMs on:
 
 - Nvidia GPUs on Linux (including unified-memory systems like the DGX Spark)
 - AMD GPUs on Linux (including AMD unified-memory systems)
 - macOS
 - Windows (via `wsl`)

 It knows how to configure common infrastructure like `docker`. It can `ssh` and `sudo` (with your
 permission) as needed to set things up.

 ## What it can do

`ai-bootstrap` is a harness (like `opencode` or `pi`), but dedicated to AI setup and maintenance. It
 can do anything that a harness can normally do, but it is specialized for understanding how to maintain
 your local AI more than anything.

By default, `ai-bootstrap` stores its knowledge of your AI setup locally, but it is recommended that you
create a private github repository where it can sync information so that you can maintain your setup from
multiple machines and recover if your main machine crashes.

 
