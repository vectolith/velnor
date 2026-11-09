# Velnor Domain LoRA (`training/`)

LoRA fine-tuning harness for the behaviour layer of Velnor (`velnor-coder-v2`), built on
`HuggingFaceTB/SmolLM2-135M-Instruct` (135.4M params), trained on CPU in float32.

## What actually runs

Read from `train_velnor_lora.py`; the report is generated from these objects at runtime,
so the numbers cannot drift from the code:

| | |
|---|---|
| Base model | `HuggingFaceTB/SmolLM2-135M-Instruct` (override with `VELNOR_BASE_MODEL`) |
| Adapter | rsLoRA, r=8, alpha=16, dropout=0.05, `q_proj k_proj v_proj o_proj` |
| Trainable params | 921,600 of 135,436,608 (0.68%) |
| Curriculum | 138 examples across 12 domains, 20 held-out validation examples |
| Schedule | 3 epochs, grad accum 2, AdamW, peak LR 4e-4 to 4e-5 cosine, warmup 8% |
| Sequence length | 384 tokens, assistant-only loss masking |
| Checkpoint | best held-out val_loss writes `outputs/velnor-coder-v2/adapter` |

## Files

- `download_base_model.py` fetches the base model to `models/smollm2-135m`.
- `train_velnor_lora.py` is the training and evaluation run.
- `grade_generations.py` applies an objective rubric to sample generations: net burn
  arithmetic, constant-time HMAC advice, secret refusal, no fabricated booking receipts.
  The base model and the tuned model are both graded and the counts land in the report
  under `eval`. Grade any report with `python grade_generations.py pilot_report.json`.
- `serve_adapter.py` runs the local endpoint at `http://127.0.0.1:8099/v1/chat` serving
  base + adapter, bridged to Velnor at `/api/lora-pilot`.
- `pilot_report.json` is the committed run: loss curve, provenance (git commit,
  torch/transformers/peft versions, device, seed), rubric scores, generations.

## Usage

    cd training
    python3 -m venv .venv
    ./.venv/bin/pip install -r requirements.txt
    ./.venv/bin/python download_base_model.py
    ./.venv/bin/python train_velnor_lora.py
    ./.venv/bin/python serve_adapter.py

A 135M adapter encodes tone and refusals. It does not turn the base model into a
reasoning engine, and `grade_generations.py` exists to keep that visible: read `eval.base`
and `eval.tuned` before trusting any quality claim about it.
