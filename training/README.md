# Velnor model training

This directory contains experimental LoRA training and evaluation code. Treat each run as a separately versioned experiment; do not infer the active production model from a project name or from a training notebook elsewhere.

## Product-level training objective

Velnor is intended to serve **everyone**, not only software engineers or developers. Engineering is a core strength, but the model curriculum must also support students, educators, business owners, professionals, creators, researchers, and everyday users.

The target capability areas are:

1. General reasoning, instruction following, planning, and practical problem solving.
2. Software engineering, programming, debugging, architecture, testing, and security-aware development.
3. Education, tutoring, explanations, study support, and learning at different skill levels.
4. Business and professional work, including research, analysis, writing, operations, and planning.
5. Creative ideation, content development, and structured creative workflows.
6. Research and information synthesis with source-grounded answers and calibrated uncertainty.
7. Tool-use planning, structured function selection, multi-step execution, and error recovery.
8. Multimodal understanding and assistance where supported by the selected base model and runtime.
9. Safe behaviour: privacy protection, prompt-injection resistance, refusal of disallowed requests, and strict respect for external permission checks.

## Training and release principles

- Keep the model general-purpose; do not let the coding or executive-assistant domains dominate the data mixture.
- Use a balanced, documented curriculum with examples spanning novice through expert levels and varied real-world contexts.
- Record dataset provenance, licensing, collection method, deduplication, privacy review, and train/validation/test separation.
- Prevent evaluation contamination and keep held-out tests private from training.
- Evaluate the unadapted base, pre-continuation adapter, and candidate checkpoint using the same deterministic prompts, decoding settings, and scoring rubric.
- Measure task success and quality, not just training or validation loss. Include tool-selection accuracy, factuality, calibration, instruction adherence, and safety/permission-boundary tests.
- Run regression tests after every training change and reject checkpoints that improve one domain while materially degrading others.
- Treat the model as an untrusted planner. Authentication, tenant isolation, tool permissions, approvals, and irreversible-action controls remain in the runtime and security layer.

## Current repository experiment (verified from source)

The committed training harness currently describes a 135.4M-parameter
`HuggingFaceTB/SmolLM2-135M-Instruct` base model, rsLoRA adapter, and a small
12-domain curriculum (138 examples, 20 held-out validation examples). It is a
small behaviour-layer experiment, not evidence of a broadly capable production
model and not the same thing as an 8B Qwen3 experiment.

Read `train_velnor_lora.py`, `pilot_report.json`, and `grade_generations.py`
for the exact code and reported results. The report's base-versus-tuned comparison
must be checked for methodological validity before using it as a quality claim.
A smaller adapter can test training infrastructure and behaviour shaping; it
cannot by itself establish robust general reasoning or autonomous competence.

## Files

- `download_base_model.py` fetches the configured base model.
- `train_velnor_lora.py` is the training and evaluation run.
- `grade_generations.py` applies an objective rubric to sample generations.
- `serve_adapter.py` runs the opt-in local adapter endpoint at `http://127.0.0.1:8099/v1/chat`.
- `pilot_report.json` records the committed pilot run, provenance, and evaluation output.

## Usage

```bash
cd training
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python download_base_model.py
./.venv/bin/python train_velnor_lora.py
./.venv/bin/python serve_adapter.py
```
