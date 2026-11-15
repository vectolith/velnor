"""
Local Fine-Tuning Pipeline for VELNOR-Core-Prime
Trains a high-fidelity rsLoRA adapter on the local base model using the full
curriculum and outputs production-ready adapter weights and evaluation reports.
"""

import json
import math
import os
import platform
import random
import subprocess
import time
from pathlib import Path

import torch
import transformers
import peft
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import LoraConfig, get_peft_model, PeftModel

from train_velnor_lora import (
    TRAIN,
    HELDOUT,
    SYS,
    build_example,
    eval_loss,
    generate_reply,
)
from grade_generations import CASES, grade_all

SEED = 42
random.seed(SEED)
torch.manual_seed(SEED)
torch.set_num_threads(os.cpu_count() or 4)

ROOT = Path(__file__).resolve().parent
LOCAL_1B = ROOT / "models" / "qwen2.5-coder-1.5b"
MODEL_ID = str(LOCAL_1B) if LOCAL_1B.exists() else "Qwen/Qwen2.5-Coder-1.5B-Instruct"

OUT = ROOT / "outputs" / "VELNOR-Core-Prime"
OUT.mkdir(parents=True, exist_ok=True)


def build_batches(tokenizer, pairs, max_len=512):
    batches = []
    for u, a in pairs:
        item = build_example(tokenizer, u, a, max_len=max_len)
        batches.append({
            "input_ids": item["input_ids"].unsqueeze(0),
            "attention_mask": item["attention_mask"].unsqueeze(0),
            "labels": item["labels"].unsqueeze(0),
        })
    return batches


def main():
    t0 = time.time()
    print("=" * 60)
    print("Starting local fine-tuning for VELNOR-Core-Prime")
    print(f"Base model: {MODEL_ID}")
    print(f"Output directory: {OUT}")
    print(f"Total training examples: {len(TRAIN)}")
    print(f"Held-out validation examples: {len(HELDOUT)}")
    print("=" * 60, flush=True)

    print("Loading tokenizer and base model...", flush=True)
    tok = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    tok.pad_token = tok.eos_token

    base_model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )
    base_model.config.use_cache = False

    eval_prompts = [c.prompt for c in CASES]

    # Pre-training baseline evaluation
    print("Evaluating base model pre-training baseline...", flush=True)
    base_generations = {p: generate_reply(base_model, tok, p) for p in eval_prompts}
    base_eval = grade_all(base_generations)
    print(f"Base model rubric: {base_eval['passed']}/{base_eval['total']}", flush=True)

    # Configure rsLoRA (r=16, alpha=32)
    lora_cfg = LoraConfig(
        r=16,
        lora_alpha=32,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_dropout=0.05,
        bias="none",
        use_rslora=True,
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(base_model, lora_cfg)
    model.print_trainable_parameters()

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total_params = sum(p.numel() for p in model.parameters())

    train_batches = build_batches(tok, TRAIN, max_len=256)
    val_batches = build_batches(tok, HELDOUT, max_len=256)

    pre_val_loss = eval_loss(model, val_batches)
    print(f"Pre-training validation loss: {pre_val_loss:.4f}", flush=True)

    epochs = 3
    lr = 3e-4
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)

    best_val_loss = pre_val_loss
    best_epoch = 0
    history = []
    adapter_dir = OUT / "adapter"

    print("Executing fine-tuning loop...", flush=True)
    for epoch in range(1, epochs + 1):
        model.train()
        epoch_loss = 0.0
        random.shuffle(train_batches)
        ep_t0 = time.time()

        for step, batch in enumerate(train_batches):
            optimizer.zero_grad()
            out = model(**batch)
            loss = out.loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            epoch_loss += loss.item()

            if (step + 1) % 50 == 0:
                print(f"Epoch {epoch}/{epochs} | Step {step+1}/{len(train_batches)} | Loss: {loss.item():.4f}", flush=True)

        avg_train = epoch_loss / len(train_batches)
        val_loss = eval_loss(model, val_batches)
        ep_elapsed = time.time() - ep_t0
        print(f"Epoch {epoch} finished in {ep_elapsed:.1f}s | Train: {avg_train:.4f} | Val: {val_loss:.4f}", flush=True)

        improved = val_loss < best_val_loss
        if improved:
            best_val_loss = val_loss
            best_epoch = epoch
            model.save_pretrained(str(adapter_dir))
            tok.save_pretrained(str(adapter_dir))
            print(f"--> Saved new best checkpoint at epoch {epoch} (Val loss: {val_loss:.4f})", flush=True)

        history.append({
            "epoch": epoch,
            "train_loss": round(avg_train, 5),
            "val_loss": round(val_loss, 5),
            "improved": improved,
        })

    # If no improvement occurred, save the final adapter
    if not adapter_dir.exists():
        model.save_pretrained(str(adapter_dir))
        tok.save_pretrained(str(adapter_dir))

    print("Evaluating tuned VELNOR-Core-Prime on rubric...", flush=True)
    best_model = PeftModel.from_pretrained(base_model, str(adapter_dir))
    tuned_generations = {p: generate_reply(best_model, tok, p) for p in eval_prompts}
    tuned_eval = grade_all(tuned_generations)
    print(f"Tuned model rubric: {tuned_eval['passed']}/{tuned_eval['total']}", flush=True)

    report = {
        "model_name": "VELNOR-Core-Prime",
        "base_model": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
        "base_model_repo": str(LOCAL_1B),
        "method": f"rsLoRA (r=16, alpha=32, target_modules=7)",
        "provenance": {
            "trained_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "host": f"{platform.system()} {platform.machine()}",
            "device": "cpu",
            "dtype": "bfloat16",
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "peft": peft.__version__,
            "seed": SEED,
        },
        "trainable_params": trainable,
        "total_params": total_params,
        "train_examples": len(TRAIN),
        "val_examples": len(HELDOUT),
        "epochs": epochs,
        "best_epoch": best_epoch,
        "pre_val_loss": round(pre_val_loss, 4),
        "post_val_loss": round(best_val_loss, 4),
        "loss_reduction_pct": round(100.0 * (pre_val_loss - best_val_loss) / pre_val_loss, 2),
        "eval": {
            "base": base_eval,
            "tuned": tuned_eval,
            "delta_passed": tuned_eval["passed"] - base_eval["passed"],
        },
        "epoch_history": history,
        "sample_generations": tuned_generations,
        "elapsed_sec": round(time.time() - t0, 1),
        "adapter_path": str(adapter_dir),
    }

    with open(OUT / "training_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("=" * 60)
    print("VELNOR-Core-Prime Fine-Tuning Complete!")
    print(f"Report: {OUT / 'training_report.json'}")
    print(f"Adapter: {adapter_dir}")
    print("=" * 60, flush=True)


if __name__ == "__main__":
    main()
