# The worker: llama.cpp's CPU server with a small Qwen baked in.
#
# Multi-arch (linux/amd64, linux/arm64): the upstream llama.cpp server image
# is published for both, and the GGUF weights are architecture-neutral.
#
#   docker buildx build --platform linux/amd64,linux/arm64 -t ai-bootstrap-worker container/
#
# Swap in a fine-tuned model with --build-arg MODEL_URL=... (any GGUF).
ARG BASE=ghcr.io/ggml-org/llama.cpp:server
FROM ${BASE}

ARG MODEL_URL=https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
ARG MODEL_NAME=qwen3-4b-instruct
ADD ${MODEL_URL} /models/worker.gguf

ENV LLAMA_ARG_MODEL=/models/worker.gguf \
    LLAMA_ARG_ALIAS=${MODEL_NAME} \
    LLAMA_ARG_HOST=0.0.0.0 \
    LLAMA_ARG_PORT=8080 \
    LLAMA_ARG_CTX_SIZE=32768 \
    LLAMA_ARG_JINJA=1

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s \
  CMD curl -sf http://127.0.0.1:8080/health || exit 1
