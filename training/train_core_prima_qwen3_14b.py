"""Free-CUDA QLoRA trainer for VELNOR Core Prima (Qwen3-14B).

This creates an adapter, not a foundation model. The script refuses CPU training,
wrong architectures, undersized GPUs, contaminated curriculum splits, and
overwriting an existing run. It uses a separate Core Prima curriculum.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import random
import subprocess
import time
from pathlib import Path

import bitsandbytes as bnb
import peft
import torch
import transformers
from family_runtime import family_system_prompt
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

MODEL_ID = "Qwen/Qwen3-14B"
SEED = 31415
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
MIN_TOTAL_VRAM_GIB = float(os.environ.get("VELNOR_PRIMA_MIN_TOTAL_VRAM_GIB", "24"))
MIN_FREE_VRAM_GIB = float(os.environ.get("VELNOR_PRIMA_MIN_FREE_VRAM_GIB", "22"))
MAX_SEQ_LEN = int(os.environ.get("VELNOR_PRIMA_MAX_SEQ_LEN", "512"))
EPOCHS = int(os.environ.get("VELNOR_PRIMA_EPOCHS", "2"))
GRAD_ACCUM = int(os.environ.get("VELNOR_PRIMA_GRAD_ACCUM", "16"))
LR = float(os.environ.get("VELNOR_PRIMA_LR", "8e-5"))
OUT = Path(os.environ.get("VELNOR_PRIMA_OUTPUT", "outputs/velnor-core-prima-qwen3-14b"))
ROOT = Path(__file__).resolve().parent
CURRICULUM = ROOT / "core_prima_curriculum.jsonl"
CONTRACT = ROOT / "model_family_contract.json"

random.seed(SEED)
torch.manual_seed(SEED)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def gpu_preflight() -> dict:
    if not torch.cuda.is_available():
        raise RuntimeError("Core Prima release training requires CUDA; CPU training is disabled.")
    props = torch.cuda.get_device_properties(0)
    free_bytes, _ = torch.cuda.mem_get_info(0)
    total, free = props.total_memory / 1024**3, free_bytes / 1024**3
    if total < MIN_TOTAL_VRAM_GIB or free < MIN_FREE_VRAM_GIB:
        raise RuntimeError(
            f"GPU preflight failed: {props.name}, total={total:.2f} GiB, free={free:.2f} GiB; "
            f"requires {MIN_TOTAL_VRAM_GIB:.1f} GiB total and {MIN_FREE_VRAM_GIB:.1f} GiB free. "
            "No model was loaded and no training started."
        )
    return {"name": props.name, "total_vram_gib": round(total, 2),
            "free_vram_gib": round(free, 2), "cuda": torch.version.cuda,
            "bf16_supported": bool(torch.cuda.is_bf16_supported())}


def load_data():
    if not CURRICULUM.is_file() or not CONTRACT.is_file():
        raise FileNotFoundError("Core Prima curriculum or shared family contract is missing.")
    records = [json.loads(line) for line in CURRICULUM.read_text(encoding="utf-8").splitlines() if line.strip()]
    ids = [row["id"] for row in records]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate curriculum IDs.")
    train = [r for r in records if r.get("split") == "train"]
    valid = [r for r in records if r.get("split") == "validation"]
    if not train or not valid:
        raise ValueError("Both train and validation splits must be non-empty.")
    if set(r["prompt"] for r in train) & set(r["prompt"] for r in valid):
        raise ValueError("Train/validation prompt leakage detected.")
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    return train, valid, contract


def encode(tokenizer, row, system_prompt):
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": row["prompt"]},
        {"role": "assistant", "content": row["answer"]},
    ]
    full = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=False)
    prefix = tokenizer.apply_chat_template(messages[:2], tokenize=True, add_generation_prompt=True)
    if len(full) > MAX_SEQ_LEN:
        raise ValueError(f"{row['id']} has {len(full)} tokens, exceeding MAX_SEQ_LEN={MAX_SEQ_LEN}; refusing silent truncation.")
    labels = list(full)
    labels[:len(prefix)] = [-100] * min(len(prefix), len(labels))
    if not any(token != -100 for token in labels):
        raise ValueError(f"{row['id']} has no assistant target tokens.")
    return {"input_ids": torch.tensor(full, dtype=torch.long),
            "attention_mask": torch.ones(len(full), dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long)}


def collate(rows, pad_id):
    width = max(len(r["input_ids"]) for r in rows)
    batch = {}
    for key, pad in (("input_ids", pad_id), ("attention_mask", 0), ("labels", -100)):
        batch[key] = torch.stack([
            torch.nn.functional.pad(r[key], (0, width - len(r[key])), value=pad) for r in rows
        ])
    return batch


@torch.no_grad()
def evaluate_loss(model, encoded, pad_id):
    model.eval()
    losses = []
    for start in range(0, len(encoded), 1):
        batch = {k: v.unsqueeze(0).to("cuda") for k, v in encoded[start].items()}
        losses.append(float(model(**batch).loss.detach().cpu()))
    return sum(losses) / max(1, len(losses))


def main():
    if EPOCHS < 1 or GRAD_ACCUM < 1 or MAX_SEQ_LEN < 256 or LR <= 0:
        raise ValueError("Invalid Core Prima training configuration.")
    if OUT.exists() and any(OUT.iterdir()):
        raise RuntimeError(f"Refusing to overwrite non-empty output directory: {OUT}")
    gpu = gpu_preflight()
    config = AutoConfig.from_pretrained(MODEL_ID)
    if getattr(config, "model_type", None) != "qwen3" or int(config.num_hidden_layers) < 40:
        raise RuntimeError("The selected model is not the expected Qwen3-14B architecture.")
    train_rows, val_rows, family = load_data()
    system_prompt = family_system_prompt("prima")

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    train = [encode(tokenizer, row, system_prompt) for row in train_rows]
    valid = [encode(tokenizer, row, system_prompt) for row in val_rows]

    compute_dtype = torch.bfloat16 if gpu["bf16_supported"] else torch.float16
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=compute_dtype)
    base = AutoModelForCausalLM.from_pretrained(
        MODEL_ID, quantization_config=quant, device_map={"": 0},
        low_cpu_mem_usage=True, attn_implementation="sdpa")
    base.config.use_cache = False
    base = prepare_model_for_kbit_training(
        base, use_gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False})
    available = {name.rsplit(".", 1)[-1] for name, _ in base.named_modules()}
    missing = sorted(set(TARGET_MODULES) - available)
    if missing:
        raise RuntimeError(f"Expected Qwen3-14B LoRA modules missing: {missing}")

    lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
        use_rslora=True, target_modules=TARGET_MODULES, task_type="CAUSAL_LM")
    model = get_peft_model(base, lora)
    model.print_trainable_parameters()
    before_loss = evaluate_loss(model, valid, tokenizer.pad_token_id)

    optimizer = bnb.optim.PagedAdamW8bit(
        [p for p in model.parameters() if p.requires_grad], lr=LR, weight_decay=0.01)
    steps_per_epoch = math.ceil(len(train) / GRAD_ACCUM)
    total_steps = steps_per_epoch * EPOCHS
    warmup = max(1, int(total_steps * 0.05))
    best_loss, best_epoch, history = before_loss, 0, []
    started = time.time()

    for epoch in range(1, EPOCHS + 1):
        model.train()
        order = list(range(len(train)))
        random.shuffle(order)
        optimizer.zero_grad(set_to_none=True)
        losses = []
        for step, idx in enumerate(order, 1):
            batch = {k: v.unsqueeze(0).to("cuda") for k, v in train[idx].items()}
            loss = model(**batch).loss
            losses.append(float(loss.detach().cpu()))
            group_start = ((step - 1) // GRAD_ACCUM) * GRAD_ACCUM
            group_size = min(GRAD_ACCUM, len(order) - group_start)
            (loss / group_size).backward()
            if step % GRAD_ACCUM == 0 or step == len(order):
                opt_step = (epoch - 1) * steps_per_epoch + math.ceil(step / GRAD_ACCUM)
                if opt_step <= warmup:
                    lr_now = LR * opt_step / warmup
                else:
                    progress = (opt_step - warmup) / max(1, total_steps - warmup)
                    lr_now = LR * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * progress)))
                for group in optimizer.param_groups:
                    group["lr"] = lr_now
                torch.nn.utils.clip_grad_norm_(
                    [p for p in model.parameters() if p.requires_grad], 1.0)
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)

        val_loss = evaluate_loss(model, valid, tokenizer.pad_token_id)
        improved = val_loss < best_loss
        history.append({"epoch": epoch, "train_loss": sum(losses)/len(losses),
                        "validation_loss": val_loss, "improved": improved})
        print(f"[core-prima] epoch={epoch} train_loss={sum(losses)/len(losses):.5f} "
              f"val_loss={val_loss:.5f} improved={improved}", flush=True)
        if improved:
            best_loss, best_epoch = val_loss, epoch
            OUT.mkdir(parents=True, exist_ok=True)
            model.save_pretrained(OUT, safe_serialization=True)
            tokenizer.save_pretrained(OUT)

    if best_epoch == 0:
        raise RuntimeError("No epoch improved held-out loss; no promotable adapter was selected.")
    if not (OUT / "adapter_config.json").is_file() or not (OUT / "tokenizer_config.json").is_file():
        raise RuntimeError("Adapter or tokenizer artifacts are missing after save.")

    try:
        git_sha = subprocess.check_output(["git", "rev-parse", "HEAD"],
            cwd=ROOT.parent, text=True).strip()
    except Exception:
        git_sha = None
    report = {
        "status": "trained_candidate_not_promoted",
        "model_name": "VELNOR Core Prima",
        "family_contract_version": family["contract_version"],
        "base_model": MODEL_ID,
        "training_type": "4-bit NF4 QLoRA adapter fine-tuning; not pretraining",
        "method": {"quantization": "NF4 double quantization", "adapter": "rsLoRA",
            "rank": 16, "alpha": 32, "dropout": 0.05, "target_modules": TARGET_MODULES,
            "gradient_checkpointing": True, "optimizer": "PagedAdamW8bit",
            "max_sequence_length": MAX_SEQ_LEN, "micro_batch_size": 1,
            "gradient_accumulation": GRAD_ACCUM, "epochs_requested": EPOCHS, "learning_rate": LR},
        "dataset": {"path": str(CURRICULUM), "train_examples": len(train_rows),
            "validation_examples": len(val_rows), "sha256": sha256_file(CURRICULUM),
            "train_ids": [r["id"] for r in train_rows], "validation_ids": [r["id"] for r in val_rows]},
        "validation": {"initial_loss": before_loss, "best_loss": best_loss,
            "best_epoch": best_epoch, "history": history},
        "provenance": {"git_commit": git_sha, "gpu": gpu, "seed": SEED,
            "torch": torch.__version__, "transformers": transformers.__version__,
            "peft": peft.__version__, "bitsandbytes": getattr(bnb, "__version__", "unknown"),
            "trained_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "duration_seconds": round(time.time() - started, 2)},
        "promotion": {"eligible": False,
            "reason": "Training/validation loss alone is insufficient. Run the paired Prime-vs-Prima family benchmark and review safety/identity gates."}
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "training_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    files = []
    for path in sorted(OUT.rglob("*")):
        if path.is_file() and path.name != "SHA256SUMS":
            files.append(f"{sha256_file(path)}  {path.relative_to(OUT).as_posix()}")
    (OUT / "SHA256SUMS").write_text("\n".join(files) + "\n", encoding="utf-8")
    print(f"[core-prima] candidate saved to {OUT}; promotion remains pending comparative evaluation.", flush=True)


if __name__ == "__main__":
    main()
