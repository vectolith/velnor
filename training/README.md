# Olli CPU LoRA Behavior Pilot (`training/`)

This directory contains a small, self-contained **CPU float32 LoRA behavior pilot** on `HuggingFaceTB/SmolLM2-135M-Instruct`.

> [!NOTE]
> **Scope & Provenance**: This is a narrow training-mechanics and behavioral verification experiment using 20 original authored training pairs and 6 held-out validation pairs (testing honest action reporting, credential hygiene, user isolation, and refusal to fabricate tool outputs). It is **not** a production replacement for Olli's primary LLM engines (`gemini-3.8-flash`, `gpt-4o`, `claude-3-7-sonnet-latest`).

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
