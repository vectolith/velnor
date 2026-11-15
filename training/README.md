# Velnor model training

> **Foundation-selection policy (supersedes older Qwen-specific instructions below):** Qwen3-8B and Qwen3-14B are no longer approved defaults. Both VELNOR tiers are currently unselected. Do not start either legacy Qwen-pinned trainer or rent training GPUs until the relevant foundation is benchmarked, its license reviewed, runtime compatibility verified, and the selection recorded in `foundation_model_candidates.json`. Use `train_selected_adapter.py` only after this gate is satisfied. The existing Qwen-specific scripts are retained for reproducibility but fail closed unless their exact model is explicitly selected and validated.

This directory contains experimental parameter-efficient fine-tuning and evaluation code. Every run is an experiment; a training objective or report is not proof that a checkpoint is production-ready.

## Product-level training objective

Velnor is intended to serve **everyone**, not only engineers or developers. Its curriculum must support students, educators, business owners, professionals, creators, researchers, and everyday users while retaining strong engineering capability.

Target capabilities include:

1. General reasoning, instruction following, planning, and practical problem solving.
2. Software engineering, programming, debugging, architecture, testing, and security-aware development.
3. Education, tutoring, explanations, study support, and learning at different skill levels.
4. Business and professional work, including research, analysis, writing, operations, and planning.
5. Creative ideation, content development, and structured creative workflows.
6. Research and information synthesis with source-grounded answers and calibrated uncertainty.
7. Tool-use planning, structured function selection, multi-step execution, and error recovery.
8. Multimodal assistance where supported by the selected base model and runtime.
9. Safe behaviour: privacy protection, prompt-injection resistance, refusal of disallowed requests, and respect for external permission checks.

The model is an untrusted planner. Authentication, tenant isolation, tool permissions, approvals, and irreversible-action controls remain in the runtime and security layer.

## Current training implementation

The compact fallback script `train_velnor_lora.py` trains an rsLoRA adapter using **Qwen2.5-1.5B-Instruct** by default. Set `VELNOR_BASE_MODEL` to override the model identifier or local model path. The preferred high-capacity route is `train_qwen3_8b_qlora.py`: **Qwen3-8B with 4-bit NF4 QLoRA**, gradient checkpointing, and a free-GPU preflight requiring 14 GiB total / 12 GiB free VRAM. Both paths consume the same expanded curriculum and held-out set.

The curriculum combines:
- 138 existing examples covering engineering, quantitative reasoning, research, productivity, security, and agent boundaries, plus 150 general-purpose examples (15 each across 10 additional domains), for 288 training examples total.
- 150 additional original examples in `general_curriculum.jsonl`, covering general reasoning, education, business, writing, research, creative work, personal productivity, data science, health information, and safe agent use.
- 30 held-out language-model validation examples in the training script. The separate generation benchmark in `grade_generations.py` contains 27 deterministic checks across multiple domains.

The added JSONL records are synthetic original examples marked `CC0-1.0`. The script records the external dataset SHA-256 in the generated report. Review the dataset and licensing metadata before adding any third-party material.

**Training is full-curriculum by default.** `VELNOR_FAST_TRAIN=1` opts into a 36-example smoke run and must not be used to produce or promote a release checkpoint. The trainer requires CUDA by default and checks for at least 8 GiB of free GPU memory before loading the model. `VELNOR_ALLOW_CPU=1` bypasses that guard only for local smoke tests; CPU runs are not valid release training.

## Evaluation requirements

- On continuation runs, evaluate three separate arms with identical prompts and deterministic decoding: unadapted base (adapter disabled), resumed adapter before continuation, and selected adapter after continuation. Fresh runs compare the unadapted base and selected adapter.
- Use identical prompts and deterministic decoding settings for both model arms.
- Report per-domain results, missing responses, model and adapter identifiers, dataset hash, training configuration, and hardware provenance.
- Treat the 27 deterministic rubric checks as regression signals, not as a substitute for expert human review.
- Keep held-out evaluation prompts out of training data and avoid promoting checkpoints based on training loss alone.
- Reject checkpoints that improve one domain while materially degrading another or violating security and permission boundaries.

## Important status distinction

The committed `pilot_report.json` is a historical run using `Qwen/Qwen2.5-Coder-1.5B-Instruct` on CPU with 138 training examples and a six-check rubric. It predates the general-purpose curriculum and the new evaluation harness. Its metrics are **not** results for the new dataset, new base-model default, or expanded benchmark.

No new training run or model weights are included in this change. The Qwen3 continuation path deliberately evaluates the resumed adapter against the new held-out split and resets checkpoint selection to that measured baseline; the previous run's validation loss is retained only as historical metadata, not compared across different datasets. A candidate checkpoint must be trained and evaluated on the intended free GPU environment before any quality or deployment claim is made.

## Files

- `train_velnor_lora.py`: compact 1.5B rsLoRA training path and shared curriculum helpers.
- `train_qwen3_8b_qlora.py`: preferred 8B QLoRA training and continuation path.
- `requirements-gpu.txt` and `requirements-qwen3-qlora.txt`: GPU-runtime dependencies that preserve the CUDA-enabled PyTorch supplied by the runtime.
- `Velnor_Qwen3_8B_General_Free_GPU.ipynb`: preferred free-GPU Qwen3-8B notebook; resumes the prior Drive adapter if present.
- `general_curriculum.jsonl`: 150 original general-purpose instruction examples, balanced at 15 per domain.
- `Velnor_General_1.5B_Free_GPU.ipynb`: Colab-compatible notebook for a free CUDA GPU run and artifact export.
- `grade_generations.py`: 27 deterministic cross-domain generation checks.
- `pilot_report.json`: historical experiment report; not the result of the new curriculum.
- `serve_adapter.py`: opt-in local adapter endpoint at `http://127.0.0.1:8099/v1/chat`.

## Verification and usage

Run the lightweight data/evaluator contract tests before training:

```bash
python -m unittest discover -s training -p 'test_*.py'
```

Use a free CUDA GPU runtime with the matching NVIDIA driver. Install the GPU-capable dependencies, then run the full curriculum:

```bash
cd training
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
VELNOR_BASE_MODEL=Qwen/Qwen2.5-1.5B-Instruct ./.venv/bin/python train_velnor_lora.py
```

For a short smoke run only:

```bash
VELNOR_FAST_TRAIN=1 VELNOR_ALLOW_CPU=1 ./.venv/bin/python train_velnor_lora.py
```


## E2 Qwen3-8B training path

Use `Velnor_Qwen3_8B_QLoRA_E2.ipynb` for the corrected continuation workflow. It invokes the canonical `train_qwen3_8b_qlora.py` entrypoint and keeps the base model fixed to `Qwen/Qwen3-8B`.

E2 is free-GPU-only: it refuses CPU execution and requires at least 14 GiB total VRAM and 12 GiB free VRAM. It defaults to one epoch, sequence length 256, micro-batch 1, gradient accumulation 8, rsLoRA rank 8 / alpha 16, and 4-bit NF4 with double quantization. It does not switch to Qwen2.5 or Llama, and it rejects resume adapters whose base model, task type, rank, or target modules do not match the Qwen3-8B contract.

Checkpoint selection starts with the resumed adapter's measured loss on the current held-out split. A historical validation loss from a different split is recorded only as metadata and is never used for selection. A worse epoch never overwrites the selected adapter. The trainer writes immutable epoch checkpoints, a training report, dataset fingerprints, and a SHA-256 manifest.

The notebook stores model artifacts in a timestamped Google Drive run directory. It does not store GitHub tokens, force-push, create duplicate pull requests, or commit adapter weights to the repository. The existing 1.5B baseline and historical run records remain unchanged.

The E2 promotion gate is a screening signal only: it requires a newly selected checkpoint, no held-out loss regression, and no regression on the deterministic generation rubric against the resumed adapter for continuation runs (or the unadapted base for fresh runs) before human review. The report preserves the legacy base/tuned rubric fields while recording all three arms explicitly. It is not production certification. No GPU training is claimed until the notebook is actually run on an eligible free CUDA runtime.


## VELNOR model family: Core Prime and Core Prima

The two tiers share a versioned behavioural contract in `model_family_contract.json`. The canonical shared system prompt is loaded by `train_velnor_lora.py`, which supplies the prompt used by the Prime QLoRA path. Tier-specific identity is supplied by release metadata and each tier's own curriculum.

- **Core Prime** — foundational tier, `Qwen/Qwen3-8B`.
- **Core Prima** — advanced flagship tier, `Qwen/Qwen3-14B`.

The adapters and curricula are separate. Prima is not trained by simply appending more examples to Prime. Its independent `core_prima_curriculum.jsonl` targets difficult multi-step reasoning, concurrency, distributed systems, quantitative analysis, planning, tool-failure recovery, research methodology, reliability, and family-contract behaviour.

### Core Prima QLoRA run

Entry point: `train_core_prima_qwen3_14b.py`

The trainer is free-CUDA-only and deliberately fails closed. Defaults are Qwen3-14B, 4-bit NF4 with double quantization, rsLoRA rank 16 / alpha 32, dropout 0.05, gradient checkpointing, micro-batch 1, gradient accumulation 16, sequence length 512, and two epochs. The default preflight requires at least 24 GiB total and 22 GiB free VRAM. These are conservative guardrails, not a guarantee that every 24 GiB GPU can complete the run; memory headroom depends on runtime overhead and sequence lengths. The trainer does not silently truncate examples or fall back to CPU/another base model.

Run on an eligible CUDA runtime:

```bash
cd training
pip install -r requirements-qwen3-qlora.txt
python train_core_prima_qwen3_14b.py
```

Optional environment overrides are `VELNOR_PRIMA_EPOCHS`, `VELNOR_PRIMA_MAX_SEQ_LEN`, `VELNOR_PRIMA_GRAD_ACCUM`, `VELNOR_PRIMA_LR`, `VELNOR_PRIMA_OUTPUT`, `VELNOR_PRIMA_MIN_TOTAL_VRAM_GIB`, and `VELNOR_PRIMA_MIN_FREE_VRAM_GIB`. Do not lower the VRAM gate merely to force an unsupported run.

The trainer writes adapter weights, tokenizer artifacts, a training report, and SHA-256 manifest under `outputs/velnor-core-prima-qwen3-14b`. The report marks the result as a candidate, not promoted.

### Paired family evaluation

After both release adapters exist, run:

```bash
python evaluate_velnor_family.py \
  --prime-adapter /path/to/core-prime/adapter \
  --prima-adapter /path/to/core-prima/adapter \
  --out outputs/velnor-family-comparison.json
```

The evaluator runs the same deterministic 27-case generation rubric and four family identity/behaviour checks against both tiers, loading one model at a time. It records raw generations, per-domain rubric results, tier identity checks, and the Prima-minus-Prime delta. The compact rubric is a screening signal only; it does not establish flagship promotion. Promotion requires a broader pre-registered hard-task benchmark, expert review, safety non-regression, and reproducible evidence. A completed training run or lower validation loss is never sufficient by itself.

### Shared family invariants

Both tiers must preserve the same VELNOR identity, instruction hierarchy, privacy and safety boundaries, honest execution reporting, and permission requirements. Tier selection may change depth and capability, never the behavioural contract. Model weights and tokenizer artifacts remain tier-specific and are not interchangeable.

**Current status:** pipeline and curriculum files are committed on the feature branch. No Core Prima GPU training, checkpoint creation, comparative evaluation, or promotion is claimed by this documentation change.

The tier-aware prompt and release metadata resolver is `family_runtime.py`. Both training paths and the paired evaluator use it to inject the active tier name, base model, and family-contract version on top of the same shared behavioural prompt. This avoids maintaining divergent Prime/Prima system prompts.


## Foundation model selection (current policy)

The VELNOR family contract remains architecture-neutral. Prime and Prima may use different foundation architectures; they must retain the shared VELNOR identity, behavioural contract, API conventions, safety invariants, and common regression suite. Their adapters, tokenizers, and release artifacts remain separate.

The preliminary research shortlist is in `foundation_model_candidates.json`. It includes Granite 4.2, Gemma 4, Ministral 3, and Qwen3.5 as candidates only. No candidate is selected. The shortlist is not a ranking or a substitute for inspecting exact model cards and immutable revisions.

Before selecting either tier, run a reproducible evaluation covering general reasoning, coding, tool calling, instruction following, multilingual performance (including relevant African languages), context handling, factual calibration, safety, inference latency, peak VRAM, throughput, quantization quality, license obligations, and compatibility with the intended serving engine and PEFT adapter format. Compare models under matched prompts, decoding settings, hardware, and quantization. Store raw outputs, benchmark versions, model revisions, and hardware details.

A foundation selection record must include `model_id`, immutable `revision`, `license`, `evaluation_report`, and `runtime_report`. The matching tier in `model_family_contract.json` must set `foundation_status` to `validated` and `base_model` to the selected model ID. Both records must agree; until then, `foundation_config.py` blocks training before model download or GPU allocation.

The new configurable entry point is:

```bash
python train_selected_adapter.py --tier prime --output outputs/velnor-core-prime
python train_selected_adapter.py --tier prima --output outputs/velnor-core-prima
```

These commands are intentionally blocked while the selection status is not `validated`. The trainer discovers supported LoRA projection layouts and refuses unknown layouts rather than guessing. Architecture-specific unsupported models require an explicit reviewed mapping. Training loss only selects a candidate checkpoint; it does not promote a model. Prima promotion additionally requires measurable superiority on the preregistered harder benchmark and no safety or reliability regression.
