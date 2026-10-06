# Docker for model servers

## Install (Linux)

- Debian/Ubuntu/Fedora: Docker's convenience script `curl -fsSL https://get.docker.com | sh` (review
  it; ask the user), or the distribution packages (`docker.io` on Debian/Ubuntu, `moby-engine` on
  Fedora).
- Let the user run docker without sudo: `sudo usermod -aG docker $USER`, which takes effect at the
  next login. Until then use the sudo tool for docker commands.
- Check: `docker version`, `docker run --rm hello-world`.

macOS/Windows: Docker Desktop. Containers there cannot use the Mac GPU; on Windows, NVIDIA GPUs work
in Docker Desktop through WSL2.

## NVIDIA GPUs in containers

Needs a working host driver (`nvidia-smi`) and the NVIDIA Container Toolkit:

```sh
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
docker run --rm --gpus all ubuntu nvidia-smi
```

(RPM-based distros use the `.repo` file from the same site.)

## AMD GPUs in containers

`--device=/dev/kfd --device=/dev/dri --group-add video --security-opt seccomp=unconfined` with ROCm
images (`rocm/vllm`, `ghcr.io/ggml-org/llama.cpp:server-rocm`). Vulkan images need only
`--device=/dev/dri`.

## Running servers well

- `--restart unless-stopped` so they come back after reboots.
- Publish to localhost unless remote access is wanted: `-p 127.0.0.1:8000:8000`.
- Mount the model cache so restarts don't re-download:
  `-v ~/.cache/huggingface:/root/.cache/huggingface`.
- `--ipc=host` (or a large `--shm-size`) for vLLM/SGLang.
- Logs: `docker logs -f <name>`; status: `docker ps`; GPU use: `nvidia-smi` on the host.
