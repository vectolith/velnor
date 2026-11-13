# Velnor model training

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

The current script trains an rsLoRA adapter using **Qwen2.5-1.5B-Instruct** by default. Set `VELNOR_BASE_MODEL` to override the model identifier or local model path. The default is a general instruction model rather than a coder-specialised checkpoint, which better matches the broad product objective.

The curriculum combines:
- 138 existing examples covering engineering, quantitative reasoning, research, productivity, security, and agent boundaries.
- 1150 additional original examples in `general_curriculum.jsonl`, covering general reasoning, education, business, writing, research, creative work, personal productivity, data science, health information, and safe agent use.
- 30 held-out language-model validation examples in the training script. The separate generation benchmark in `grade_generations.py` contains 27 deterministic checks across multiple domains.

The added JSONL records are synthetic original examples marked `CC0-1.0`. The script records the external dataset SHA-256 in the generated report. Review the dataset and licensing metadata before adding any third-party material.

**Training is full-curriculum by default.** `VELNOR_FAST_TRAIN=1` opts into a 36-example smoke run and must not be used to produce or promote a release checkpoint. The trainer requires CUDA by default and checks for at least 8 GiB of free GPU memory before loading the model. `VELNOR_ALLOW_CPU=1` bypasses that guard only for local smoke tests; CPU runs are not valid release training.

## Evaluation requirements

- Evaluate the unadapted base model with the adapter explicitly disabled, then evaluate the selected tuned checkpoint with the adapter enabled.
- Use identical prompts and deterministic decoding settings for both model arms.
- Report per-domain results, missing responses, model and adapter identifiers, dataset hash, training configuration, and hardware provenance.
- Treat the 27 deterministic rubric checks as regression signals, not as a substitute for expert human review.
- Keep held-out evaluation prompts out of training data and avoid promoting checkpoints based on training loss alone.
- Reject checkpoints that improve one domain while materially degrading another or violating security and permission boundaries.

## Important status distinction

The committed `pilot_report.json` is a historical run using `Qwen/Qwen2.5-Coder-1.5B-Instruct` on CPU with 138 training examples and a six-check rubric. It predates the general-purpose curriculum and the new evaluation harness. Its metrics are **not** results for the new dataset, new base-model default, or expanded benchmark.

No new training run or model weights are included in this change. A candidate checkpoint must be trained and evaluated on the intended free GPU environment before any quality or deployment claim is made.

## Files

- `train_velnor_lora.py`: rsLoRA training, validation, generation, and provenance reporting.
- `general_curriculum.jsonl`: 150 original general-purpose instruction examples.
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
VELNOR_FAST_TRAIN=1 VELNOR_ALLOW_CPU=1 ./.venv/bin/python training/train_velnor_lora.py
```
