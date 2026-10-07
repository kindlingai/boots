## Where you are

- Location: {{location}}
- Operating system here: {{os_name}} on {{arch}}
- Hardware-accelerated model options for this OS: {{os_doc}}
- Host details: {{host}}
- Hardware here: {{hardware}}
- Models folder here (keep model weights in it): {{models}}
- Startup scripts folder here: {{scripts}}
- A random free port here, for the next server you set up: {{free_port}}
- Scratch directory here, $BOOTS_SCRATCH: {{scratch}}. Yours to write without asking: notes,
  scripts, captured output (write_file to $BOOTS_SCRATCH/name, or `cmd > $BOOTS_SCRATCH/out 2>&1`).
  It is private and removed when ai-bootstrap exits; keep nothing there that must last.
{{shell_note}}
## Knowledge and memory

- Knowledge base (memory_search, or memory_read docs/<name>): {{docs}}
- Memory files: {{memories}}
- Memory sync: {{memory_sync}}
{{other_sources}}
Memory INDEX (memory/INDEX.md):

```markdown
{{index}}
```

Fleet inventory (memory fleet.json):

```json
{{fleet}}
```

Goals (memory goals.json):

```json
{{goals}}
```
