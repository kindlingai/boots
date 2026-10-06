# System prompts

ai-bootstrap builds its system prompt from these templates on every model turn, so edits here change
its behaviour without touching code. They are compiled into the binary along with the rest of
`docs/`.

| file         | used when                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base.md`    | the model answering is the small base intelligence (the CPU Qwen 4B, or any model of 8B parameters or fewer by its name). Focused only on getting a smarter model running. |
| `main.md`    | a capable model is answering (registered with `use_model`, or a large bootstrap such as an API model). The full harness behaviour.                                         |
| `context.md` | appended to either: where the agent is, the OS, the knowledge base, memory, the plan.                                                                                      |

A model reached with an API key (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or a key typed into
`use_model`) always gets `main.md`. `AIBOOT_TIER=base` or `AIBOOT_TIER=full` forces the choice
either way.

In base mode the session opens with a model turn instead of the "What would you like to do?" prompt,
so the model can ask its opening question.

## Placeholders

`{{name}}` is replaced when the prompt is built. An unknown name is an error.

| placeholder       | value                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `model`           | label of the model answering now                                                              |
| `bootstrap`       | label of the bootstrap model                                                                  |
| `smart`           | label of the registered smarter model, or `none`                                              |
| `fallback_note`   | a sentence when the smarter model is unavailable and the bootstrap is standing in, else empty |
| `context`         | `context.md`, rendered                                                                        |
| `location`        | hop stack, e.g. `local > admin@gpu-1`                                                         |
| `os_name`, `arch` | e.g. `Ubuntu 24.04.5 LTS, kernel 6.8`, `x86_64`                                               |
| `os_doc`          | the per-OS guide, e.g. `docs/intermediate-linux`                                              |
| `host`            | user, hostname, home, shell, cwd                                                              |
| `shell_note`      | a line when commands run in PowerShell, else empty                                            |
| `docs`            | the knowledge-base docs, comma separated                                                      |
| `memories`        | memory file names                                                                             |
| `memory_sync`     | the git remote memory syncs to, or `not set up`                                               |
| `other_sources`   | other AI sources seen at boot, or empty                                                       |
| `index`           | memory INDEX.md (4 kB at most)                                                                |
| `plan`            | the current plan, or `(none yet)`                                                             |
