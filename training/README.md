# Velnor model training

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
fine-tuning. A small free-tier VPS is not a suitable training host. The trainer
automatically uses CUDA when available, selecting BF16 only when supported and
FP16 otherwise; it falls back to CPU/FP32 when no GPU is present.

For a CUDA runtime (for example, a Colab GPU session), install
`requirements-gpu.txt`, not the CPU-pinned `requirements.txt`. The GPU
requirements intentionally omit PyTorch so the runtime's CUDA-enabled build is
not replaced by a CPU-only wheel. Open `Velnor_Qwen_1.5B_Colab.ipynb` and run
the cells in order. The notebook refuses to train if CUDA is unavailable,
persists epoch checkpoints directly to Google Drive, and saves the final adapter
archive, report, log, and SHA-256 manifest there as well.
Do not start a paid instance without checking its total cost first.

A lower validation loss is useful but does not prove better task performance.
Review both `eval.base` and `eval.tuned`, broaden the held-out benchmark, and
retain the previous adapter until the candidate passes the acceptance gate.


## Qwen3-8B free-GPU QLoRA candidate

The separate train_qwen3_8b_qlora.py entrypoint targets Qwen/Qwen3-8B using 4-bit NF4 quantization, double quantization, gradient checkpointing, and rsLoRA. It reuses the existing 1.5B curriculum and held-out rubric without modifying the canonical 1.5B trainer or replacing its baseline. This is adapter fine-tuning, not pretraining a foundation model.

Use requirements-qwen3-qlora.txt in a CUDA runtime that already provides CUDA-enabled PyTorch. The file adds bitsandbytes and includes the existing GPU requirements without installing a different PyTorch wheel.

The trainer requires a visible CUDA GPU with at least 14 GiB total and 12 GiB free VRAM at preflight. It refuses CPU execution and insufficient memory. Passing preflight is not a guarantee: Qwen3-8B QLoRA may still OOM on a free 16 GB T4 because runtime overhead and activation memory vary. Reduce VELNOR_QWEN3_MAX_SEQ_LEN only after preserving the held-out evaluation contract; do not silently switch to a smaller model or claim a run completed when it did not. No paid runtime is required or authorized.

Open Velnor_Qwen3_8B_QLoRA_Colab.ipynb in Colab, select an actually available free GPU runtime, and run cells in order. Outputs are written directly to a timestamped Google Drive folder, with a report and SHA-256 manifest. If Colab does not allocate a free GPU, stop rather than enabling paid compute.

A completed run is only a candidate adapter. Review the recorded base-versus-tuned rubric delta, held-out loss, logs, checkpoint, and hashes before any deployment decision. The current curriculum (138 train / 20 held-out examples) is a small pilot set and does not establish production-grade agent capability.
