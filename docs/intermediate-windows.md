# Intermediate model on Windows

Goal: a GPU-accelerated model with good tool calling behind an OpenAI-compatible API, then
`use_model` it. Commands on Windows hosts run in PowerShell.

## 1. Check the machine

```powershell
Get-CimInstance Win32_OperatingSystem | Select Caption, Version, OSArchitecture
Get-CimInstance Win32_VideoController | Select Name, AdapterRAM, DriverVersion   # AdapterRAM caps at 4 GB; use nvidia-smi for the real number
nvidia-smi                                    # NVIDIA driver present?
(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB
Get-PSDrive C
wsl --status; wsl -l -v                        # WSL2 available / installed distros
```

Choose a model by VRAM using the same table as docs/intermediate-linux (8 GB: Qwen3-8B; 16 GB:
gpt-oss-20b; 24 GB: Qwen3-30B-A3B Q4; ...).

## 2. Two routes

### Native (simplest)

- **llama.cpp**: download the release zip that matches the GPU
  (`llama-<tag>-bin-win-cuda-<ver>-x64.zip` plus the matching `cudart-*` zip for NVIDIA;
  `win-vulkan-x64` for AMD/Intel; `win-cpu-*` otherwise), unpack, and run:

  ```powershell
  .\llama-server.exe -hf unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:Q4_K_M --host 127.0.0.1 --port 8080 --jinja -c 32768 -ngl 999
  ```

- **Ollama for Windows**: installer from ollama.com; runs in the tray, API on port 11434 (`/v1` is
  OpenAI-compatible). Supports NVIDIA and many Radeon GPUs. Set `OLLAMA_CONTEXT_LENGTH` (System >
  Environment Variables) and restart it for long contexts.
- **LM Studio**: GUI with a local server on port 1234; NVIDIA (CUDA), AMD/Intel (Vulkan).

### WSL2 (for vLLM / SGLang, or Linux tooling)

vLLM and SGLang do not run natively on Windows; run them in WSL2.

1. `wsl --install -d Ubuntu-24.04` (needs admin and usually a reboot; ask first).
2. NVIDIA: install only the normal **Windows** NVIDIA driver; it exposes CUDA inside WSL. Do not
   install a Linux NVIDIA driver inside WSL. Check with `wsl nvidia-smi`.
3. Inside WSL follow docs/intermediate-linux, docs/vllm or docs/sglang.
4. WSL forwards `localhost` ports to Windows by default, so a server on `127.0.0.1:8000` in WSL is
   reachable from Windows at the same address.
5. Give WSL enough memory: `%UserProfile%\.wslconfig` with `[wsl2]` / `memory=48GB` (then
   `wsl --shutdown`).

AMD GPUs in WSL2 have limited support (ROCm on WSL covers only some Radeon cards); prefer the native
Vulkan llama.cpp build or Ollama/LM Studio.

You can also `ssh` into the WSL distro (enable sshd there) to have ai-bootstrap work inside it as a
Linux host.

## 3. Keep it running

- Ollama and LM Studio start with the user session.
- For llama-server: a Scheduled Task at logon (`Register-ScheduledTask` with
  `New-ScheduledTaskTrigger -AtLogOn`), or a service wrapper such as NSSM if it must run without a
  login.
- Allow it through the firewall only if other machines need it:
  `New-NetFirewallRule -DisplayName llama -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow`
  (ask first), and set `--api-key`.

## 4. Verify and switch

`Invoke-RestMethod http://127.0.0.1:8080/v1/models`, try a tool call, then `use_model`; record the
setup in memory.

Things that go wrong: mismatched CUDA build vs driver (update the driver or use an older `cuda-12.x`
build), missing `cudart` DLLs next to llama-server, SmartScreen blocking downloaded executables,
antivirus quarantining binaries, paths with spaces in PowerShell (quote them), WSL out of memory
(`.wslconfig`).
