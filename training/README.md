# Velnor Domain LoRA (`training/`)

LoRA fine-tuning harness for the behaviour layer of Velnor (`velnor-coder-v2`), built on
`Qwen/Qwen2.5-Coder-1.5B-Instruct` (1.5B parameters). The complete training and held-out
validation pools are used by default. This is a parameter-efficient adapter fine-tune,
not training a new foundation model from scratch.

## Training contract

The authoritative implementation is `train_velnor_lora.py`. Run reports record the
actual selected example counts and runtime provenance.

| Setting | Value |
|---|---|
| Base model | `Qwen/Qwen2.5-Coder-1.5B-Instruct` (override with `VELNOR_BASE_MODEL`) |
| Adapter | rsLoRA, rank 8, alpha 16, dropout 0.05, target modules `q_proj` and `v_proj` |
| Curriculum | 138 training examples and 20 held-out validation examples in the full pool |
| Schedule | 3 epochs, gradient accumulation 2, AdamW, cosine decay, 8% warmup |
| Sequence length | 256 tokens, assistant-only loss masking |
| Output | `outputs/velnor-coder-v2/adapter` and `pilot_report.json` |

The default is a full run. For a deliberately reduced smoke run only, set
`VELNOR_FAST_TRAIN=1`. The report will record the reduced training and validation
counts separately from the full pool. Do not compare a smoke-run metric with a
full-curriculum metric as though the experiments were equivalent.

## Files

- `download_base_model.py` downloads the canonical Qwen 1.5B base model to
  `models/qwen2.5-coder-1.5b`.
- `train_velnor_lora.py` performs fine-tuning, validation, checkpoint selection,
  and base-versus-adapter rubric evaluation.
- `train_fast_1b.py` and `run_fast_1b_pass.py` are compatibility wrappers that delegate
  to the canonical trainer in explicit smoke-run mode.
- `grade_generations.py` applies deterministic checks for identity, arithmetic,
  HMAC advice, credential refusal, and fabricated booking receipts.
- `evaluate_adapter.py` re-evaluates an adapter saved on disk against the full
  held-out set and rubric.
- `serve_adapter.py` exposes the local adapter endpoint at
  `http://127.0.0.1:8099/v1/chat`.

## Usage

```bash
cd training
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python download_base_model.py
python train_velnor_lora.py
python grade_generations.py pilot_report.json
python serve_adapter.py
```

The 1.5B base model requires several GB of storage and substantial memory for
fine-tuning. A small free-tier VPS is not a suitable training host. Use a machine
with adequate RAM and preferably a supported GPU; do not start a paid instance
without checking its total cost first.

A lower validation loss is useful but does not prove better task performance.
Review both `eval.base` and `eval.tuned`, broaden the held-out benchmark, and
retain the previous adapter until the candidate passes the acceptance gate.
