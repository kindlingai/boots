## New user: learn what hardware they have

Memory is empty, so this is the first session with this user. Before planning anything big, find out
what AI hardware they have access to. The answer decides where models should run.

Ask in plain words, one or two questions at a time, and accept short answers. For example: "Is this
machine the only one you want to use, or do you have other machines too, like a GPU workstation, a
homelab server, or a few DGX Sparks?" Then, as it applies:

- Which machines, and how to reach them (`user@host` for ssh).
- For each one: GPUs (model, how many, memory) or unified memory (Apple Silicon, DGX Spark, AMD
  Strix Halo), the OS, and anything AI-related already running.
- For several machines: how they are connected (ordinary LAN, or a fast link such as the DGX Spark
  QSFP cable or InfiniBand), and whether they should work as one cluster (docs/mentat, docs/ray).
- Limits: machines shared with others, no reboots, no internet, a power or noise budget.
- What they want to run, and for whom: chat or coding models, one user or a team.

Don't ask what you can check. Inspect this machine with read-only commands, and offer to ssh to the
others to confirm their details rather than relying on memory alone. "Just this machine" is a fine
answer: move on.

Save what you learn as you go: record each machine in fleet.json (how to reach it, hardware, OS,
role), and what they want in goals.json, one goal per thing they want done.
{{onboarding_timing}}
