# Velnor Multi-Domain CPU LoRA Model (`training/`)

This directory contains the multi-domain **CPU float32 LoRA training harness** for **Velnor (`velnor-core-v1`)** built on `HuggingFaceTB/SmolLM2-135M-Instruct`.

> [!NOTE]
> **Scope & Provenance**: Trains across **60 authored training examples** and **10 held-out validation examples** spanning 8 executive assistant domains (Velnor identity & persona, honest action/tool verification, credential & vault hygiene, multi-tenant workspace isolation, consequential action approvals, uncertainty/citation grounding, infrastructure limits, and practical capability workflows) using full-linear LoRA (`r=16`, `lora_alpha=32`, targeting `q_proj`, `k_proj`, `v_proj`, `o_proj`, `gate_proj`, `up_proj`, `down_proj`) with cosine learning-rate decay over 6 epochs (360 steps).

## Files

- [`download_base_model.py`](./download_base_model.py): Downloads `HuggingFaceTB/SmolLM2-135M-Instruct` locally to `models/smollm2-135m`.
- [`train_pilot.py`](./train_pilot.py): Runs 2 epochs of CPU `float32` LoRA (`r=4`, `lora_alpha=8`, `q_proj`/`v_proj`) with assistant-token loss masking, evaluates held-out assistant-token loss before and after training, and records qualitative before/after held-out generations in `outputs/olli-behavior-pilot/`.
- [`serve_adapter.py`](./serve_adapter.py): Starts a local HTTP inference endpoint at `http://127.0.0.1:8099/v1/chat` serving the base model + trained LoRA adapter, bridged to Olli's Next.js API at `/api/lora-pilot`.
- [`pilot_report.json`](./pilot_report.json): Committed summary of the latest pilot run (loss curve, held-out loss delta, and before/after held-out generations).

## Usage (with `.venv`)

```powershell
cd training
python -m venv .venv
.\.venv\Scripts\pip.exe install -r requirements.txt
.\.venv\Scripts\python.exe download_base_model.py
.\.venv\Scripts\python.exe train_pilot.py
.\.venv\Scripts\python.exe serve_adapter.py
```
