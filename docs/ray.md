# Ray (distributed inference and serving)

Ray is a Python framework for running work across a cluster of machines. For local AI it matters in
two ways:

1. **Multi-node vLLM.** vLLM uses Ray to spread one model over GPUs on several machines (tensor
   parallel within a node, pipeline parallel across nodes).
2. **Ray Serve / Ray Serve LLM.** A serving layer that runs model replicas (usually vLLM engines)
   behind an OpenAI-compatible endpoint, with autoscaling and multi-model routing.

Use Ray when one machine is not enough for the model, or to serve several models from a pool of GPU
boxes. For one machine, run vLLM, SGLang or llama.cpp directly (docs/vllm, docs/sglang,
docs/llama-cpp): Ray adds moving parts.

For a few nodes, mentat (docs/mentat) is a lighter replacement for Ray under vLLM, with a built-in
router that gives one OpenAI endpoint for every model.

## Golden rule: identical environments

Every node needs the **same** Python version, Ray version, vLLM version, CUDA/driver generation, and
the model files at the same path (or the same Hugging Face cache). Mismatches are the main cause of
failures. The usual way to get that is the same container image on every node
(`vllm/vllm-openai:<tag>` contains Ray), or one virtualenv built the same way everywhere.

## Start a cluster by hand

On the head node:

```sh
ray start --head --port=6379 --dashboard-host=0.0.0.0     # dashboard on :8265
```

On each worker:

```sh
ray start --address=<head-ip>:6379
```

Check it from any node: `ray status` (should list every node and the total GPUs). Stop with
`ray stop`.

In containers, run each node's container with `--network=host --ipc=host --gpus all` (and
`--shm-size` large), then run `ray start` inside it. vLLM's repository ships a helper script
(`examples/online_serving/run_cluster.sh`) that does this.

## Multi-node vLLM on the Ray cluster

On the head node, once `ray status` shows all GPUs:

```sh
vllm serve <model> \
  --tensor-parallel-size <GPUs per node> \
  --pipeline-parallel-size <number of nodes> \
  --distributed-executor-backend ray \
  --host 0.0.0.0 --port 8000
```

Example: 2 nodes × 8 GPUs → `--tensor-parallel-size 8 --pipeline-parallel-size 2`. Tensor
parallelism across nodes needs very fast interconnect (InfiniBand/RoCE); over ordinary Ethernet keep
tensor parallel inside a node and use pipeline parallel between nodes.

## Networking

- Open between nodes: the GCS port (6379), the dashboard (8265, optional), plus Ray's worker port
  ranges, and NCCL traffic. On a trusted LAN the simplest setup is to allow all traffic between the
  cluster nodes.
- Pick the right network interface for NCCL/Gloo when nodes have several:
  `NCCL_SOCKET_IFNAME=eth0 GLOO_SOCKET_IFNAME=eth0` (set on every node before `ray start`).
- `NCCL_DEBUG=INFO` shows which transport NCCL picked; `NCCL_IB_DISABLE=1` if InfiniBand is present
  but misconfigured.
- Set `VLLM_HOST_IP=<this node's ip>` on each node if vLLM picks the wrong address.
- Ray has no authentication by default: never expose 6379 or 8265 to the internet.

## Ray Serve LLM

```sh
pip install "ray[serve,llm]"
```

```python
# serve_llm.py
from ray import serve
from ray.serve.llm import LLMConfig, build_openai_app

llm = LLMConfig(
    model_loading_config={"model_id": "qwen3-30b", "model_source": "Qwen/Qwen3-30B-A3B-Instruct-2507"},
    deployment_config={"autoscaling_config": {"min_replicas": 1, "max_replicas": 2}},
    engine_kwargs={"tensor_parallel_size": 2, "max_model_len": 32768},
)
serve.run(build_openai_app({"llm_configs": [llm]}), blocking=True)
```

`python serve_llm.py` (on a node of a running Ray cluster) serves `http://<host>:8000/v1`. The API
has changed between Ray releases: check the installed version's docs
(`python -c "import ray; print(ray.__version__)"`) and adjust.

## On Kubernetes

KubeRay (`helm install kuberay-operator kuberay/kuberay-operator`) provides `RayCluster` and
`RayService` resources; use them instead of hand-run `ray start` when the user already runs
Kubernetes.

## Troubleshooting

- `ray status` shows fewer GPUs than expected: the worker did not join (firewall, wrong address) or
  its container lacks `--gpus all`.
- vLLM hangs at start in multi-node: NCCL cannot connect; check interfaces and firewall, run with
  `NCCL_DEBUG=INFO`.
- Version mismatch errors on join: rebuild nodes from the same image.
- Out of memory: same remedies as docs/vllm (`--max-model-len`, quantized model).
