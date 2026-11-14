"""Free-GPU QLoRA fine-tuning entrypoint for Qwen3-8B.

This is adapter fine-tuning, not foundation-model pretraining. It deliberately
refuses CPU execution and small/low-memory GPUs. A successful preflight is not
a guarantee that a free Colab runtime will complete without OOM.
"""
from __future__ import annotations

import json
import math
import os
import platform
import random
import subprocess
import time
import shutil
from pathlib import Path

import torch
import bitsandbytes as bnb
import transformers
import peft
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, PeftModel, get_peft_model, prepare_model_for_kbit_training

# Reuse the audited VELNOR curriculum and rubric helpers without invoking its
# 1.5B training main(). This keeps the baseline trainer unchanged.
from train_velnor_lora import (
    TRAIN, HELDOUT, SYS, build_example, eval_loss, generate_reply,
)
from grade_generations import CASES, grade_all

MODEL_ID = "Qwen/Qwen3-8B"
SEED = 42
MAX_SEQ_LEN = int(os.environ.get("VELNOR_QWEN3_MAX_SEQ_LEN", "256"))
EPOCHS = int(os.environ.get("VELNOR_QWEN3_EPOCHS", "3"))
MICRO_BATCH_SIZE = 1
GRAD_ACCUM = int(os.environ.get("VELNOR_QWEN3_GRAD_ACCUM", "8"))
LR = float(os.environ.get("VELNOR_QWEN3_LR", "1e-4"))
MIN_TOTAL_VRAM_GIB = 14.0
MIN_FREE_VRAM_GIB = 12.0
OUT = Path(os.environ.get("VELNOR_QWEN3_OUTPUT", "outputs/qwen3-8b-qlora"))
# Optional continuation run: resume from an existing adapter directory and carry
# the previous best validation loss forward so a weaker continuation epoch can
# never overwrite the better adapter.
RESUME = os.environ.get("VELNOR_QWEN3_RESUME", "").strip()
PREV_BEST_LOSS = float(os.environ.get("VELNOR_QWEN3_PREV_BEST_LOSS", "inf"))
# Optional early stopping. 0 disables it and preserves the original train-for-all
# -epochs behaviour. With N>0 the loop halts after N consecutive epochs that fail
# to beat best_loss, since the adapter on disk is already the better one.
PATIENCE = int(os.environ.get("VELNOR_QWEN3_PATIENCE", "0"))
random.seed(SEED)
torch.manual_seed(SEED)


def should_stop_early(stalled_epochs: int, patience: int) -> bool:
    """True when training has gone `patience` consecutive epochs without improving.

    patience <= 0 disables early stopping, so a run always completes its EPOCHS.
    """
    return patience > 0 and stalled_epochs >= patience


def gpu_preflight() -> dict:
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU required. CPU training is intentionally disabled.")
    if torch.cuda.device_count() < 1:
        raise RuntimeError("No CUDA device is visible.")
    props = torch.cuda.get_device_properties(0)
    total_gib = props.total_memory / (1024 ** 3)
    free_bytes, total_bytes = torch.cuda.mem_get_info(0)
    free_gib = free_bytes / (1024 ** 3)
    if total_gib < MIN_TOTAL_VRAM_GIB:
        raise RuntimeError(
            f"GPU has {total_gib:.2f} GiB total VRAM; this run requires at least "
            f"{MIN_TOTAL_VRAM_GIB:.1f} GiB. No training started."
        )
    if free_gib < MIN_FREE_VRAM_GIB:
        raise RuntimeError(
            f"GPU has only {free_gib:.2f} GiB free VRAM; at least "
            f"{MIN_FREE_VRAM_GIB:.1f} GiB is required at preflight. No training started."
        )
    return {
        "name": props.name,
        "total_vram_gib": round(total_gib, 2),
        "free_vram_gib": round(free_gib, 2),
        "cuda": torch.version.cuda,
        "bf16_supported": bool(torch.cuda.is_bf16_supported()),
    }


def build_batches(tokenizer, examples):
    # One example per microbatch minimizes activation memory on a free GPU.
    batches = []
    for user_text, assistant_text in examples:
        batch = build_example(tokenizer, user_text, assistant_text, MAX_SEQ_LEN)
        if batch["labels"].ne(-100).sum().item() == 0:
            raise ValueError(
                "An example has no assistant target tokens after truncation; "
                "increase VELNOR_QWEN3_MAX_SEQ_LEN or shorten the prompt."
            )
        batches.append(batch)
    return batches


def main() -> None:
    started = time.time()
    gpu = gpu_preflight()
    if EPOCHS < 1 or GRAD_ACCUM < 1 or MAX_SEQ_LEN < 128:
        raise ValueError("EPOCHS/GRAD_ACCUM must be positive and MAX_SEQ_LEN >= 128.")
    print("[qwen3-8b] GPU preflight:", json.dumps(gpu), flush=True)
    print(
        "[qwen3-8b] Loading 4-bit NF4 base. This is a best-effort fit on free "
        "GPU capacity; CUDA OOM remains possible.",
        flush=True,
    )

    compute_dtype = torch.bfloat16 if gpu["bf16_supported"] else torch.float16
    quant_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=compute_dtype,
    )
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    base = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        quantization_config=quant_config,
        device_map={"": 0},
        low_cpu_mem_usage=True,
        attn_implementation="sdpa",
    )
    base.config.use_cache = False
    base = prepare_model_for_kbit_training(
        base,
        use_gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
    )
    # These are standard Qwen-family attention and MLP projection names.
    # Fail closed if the architecture differs rather than silently training
    # an incomplete adapter.
    module_names = {name.rsplit(".", 1)[-1] for name, _ in base.named_modules()}
    targets = ["q_proj", "k_proj", "v_proj", "o_proj",
               "gate_proj", "up_proj", "down_proj"]
    missing = [name for name in targets if name not in module_names]
    if missing:
        raise RuntimeError(f"Qwen3 architecture is missing expected LoRA modules: {missing}")

    lora_config = LoraConfig(
        r=8,
        lora_alpha=16,
        lora_dropout=0.05,
        bias="none",
        use_rslora=True,
        target_modules=targets,
        task_type="CAUSAL_LM",
    )
    if RESUME:
        resume_dir = Path(RESUME)
        if not (resume_dir / "adapter_config.json").is_file():
            raise RuntimeError(f"Resume adapter config missing under {resume_dir}")
        model = PeftModel.from_pretrained(base, str(resume_dir), is_trainable=True)
        print(f"[qwen3-8b] Resumed adapter from {resume_dir}", flush=True)
    else:
        model = get_peft_model(base, lora_config)
    model.print_trainable_parameters()
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total_params = sum(p.numel() for p in model.parameters())

    train_batches = build_batches(tokenizer, TRAIN)
    val_batches = build_batches(tokenizer, HELDOUT)
    print(
        f"[qwen3-8b] dataset train={len(train_batches)} heldout={len(val_batches)} "
        f"seq_len={MAX_SEQ_LEN} micro_batch={MICRO_BATCH_SIZE} grad_accum={GRAD_ACCUM}",
        flush=True,
    )
    pre_val_loss = eval_loss(model, val_batches)
    eval_prompts = [case.prompt for case in CASES]
    base_generations = {p: generate_reply(model, tokenizer, p) for p in eval_prompts}
    base_eval = grade_all(base_generations)

    steps_per_epoch = math.ceil(len(train_batches) / GRAD_ACCUM)
    total_steps = EPOCHS * steps_per_epoch
    warmup_steps = max(1, int(total_steps * 0.05))
    optimizer = bnb.optim.PagedAdamW8bit(
        [p for p in model.parameters() if p.requires_grad],
        lr=LR,
        weight_decay=0.01,
    )
    OUT.mkdir(parents=True, exist_ok=True)
    best_dir = OUT / "adapter"
    if best_dir.exists():
        raise RuntimeError(
            f"Output adapter directory already exists: {best_dir}. Use a fresh run directory."
        )
    if RESUME:
        # Seed the new run with the prior best adapter. If no continuation epoch
        # beats PREV_BEST_LOSS, final evaluation still has a valid best checkpoint.
        shutil.copytree(Path(RESUME), best_dir)
    history = []
    best_loss = PREV_BEST_LOSS
    best_epoch = 0
    optimizer_step = 0
    epochs_run = 0
    stalled_epochs = 0
    stopped_early = False

    for epoch in range(1, EPOCHS + 1):
        model.train()
        random.shuffle(train_batches)
        epoch_loss = 0.0
        optimizer.zero_grad(set_to_none=True)
        for index, batch in enumerate(train_batches, 1):
            batch = {k: v.to("cuda", non_blocking=True) for k, v in batch.items()}
            loss = model(**batch).loss
            epoch_loss += float(loss.detach().item())
            # Correctly scale the final, possibly incomplete accumulation group.
            group_start = ((index - 1) // GRAD_ACCUM) * GRAD_ACCUM
            group_size = min(GRAD_ACCUM, len(train_batches) - group_start)
            (loss / group_size).backward()
            boundary = index % GRAD_ACCUM == 0 or index == len(train_batches)
            if boundary:
                optimizer_step += 1
                if optimizer_step <= warmup_steps:
                    lr_now = LR * optimizer_step / warmup_steps
                else:
                    progress = (optimizer_step - warmup_steps) / max(1, total_steps - warmup_steps)
                    lr_now = LR * 0.1 + 0.5 * (LR - LR * 0.1) * (1 + math.cos(math.pi * progress))
                for group in optimizer.param_groups:
                    group["lr"] = lr_now
                torch.nn.utils.clip_grad_norm_(
                    [p for p in model.parameters() if p.requires_grad], 1.0
                )
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)

        val_loss = eval_loss(model, val_batches)
        epochs_run = epoch
        improved = val_loss < best_loss
        if improved:
            best_loss = val_loss
            best_epoch = epoch
            stalled_epochs = 0
            model.save_pretrained(best_dir)
            tokenizer.save_pretrained(best_dir)
        else:
            stalled_epochs += 1
        history.append({
            "epoch": epoch,
            "train_loss": round(epoch_loss / len(train_batches), 5),
            "val_loss": round(val_loss, 5),
            "best": improved,
        })
        print(f"[qwen3-8b] epoch={epoch} train={epoch_loss/len(train_batches):.5f} "
              f"val={val_loss:.5f} best={improved} stalled={stalled_epochs}", flush=True)
        if should_stop_early(stalled_epochs, PATIENCE):
            stopped_early = True
            print(
                f"[qwen3-8b] early stopping: {stalled_epochs} epoch(s) without "
                f"improvement over best_loss={best_loss:.5f} (patience={PATIENCE})",
                flush=True,
            )
            break

    # Reload the selected adapter for final rubric evaluation.
    del optimizer, model, base
    torch.cuda.empty_cache()
    clean_base = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        quantization_config=quant_config,
        device_map={"": 0},
        low_cpu_mem_usage=True,
        attn_implementation="sdpa",
    )
    tuned_model = PeftModel.from_pretrained(clean_base, best_dir)
    tuned_generations = {p: generate_reply(tuned_model, tokenizer, p) for p in eval_prompts}
    tuned_eval = grade_all(tuned_generations)

    try:
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=Path(__file__).resolve().parents[1],
            text=True,
        ).strip()
    except Exception:
        commit = None
    report = {
        "status": "completed",
        "training_type": "4-bit NF4 QLoRA adapter fine-tuning; not pretraining",
        "base_model": MODEL_ID,
        "method": {
            "quantization": "4-bit NF4 with double quantization",
            "compute_dtype": str(compute_dtype).replace("torch.", ""),
            "adapter": "rsLoRA",
            "rank": 8,
            "alpha": 16,
            "dropout": 0.05,
            "target_modules": targets,
            "gradient_checkpointing": True,
            "optimizer": "bitsandbytes PagedAdamW8bit",
            "micro_batch_size": MICRO_BATCH_SIZE,
            "gradient_accumulation": GRAD_ACCUM,
            "max_sequence_length": MAX_SEQ_LEN,
            "epochs": EPOCHS,
            "learning_rate": LR,
        },
        "provenance": {
            "git_commit": commit,
            "trained_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "host": f"{platform.system()} {platform.machine()}",
            "gpu": gpu,
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "peft": peft.__version__,
            "seed": SEED,
        },
        "dataset": {
            "train_examples": len(TRAIN),
            "heldout_examples": len(HELDOUT),
            "resumed_from": RESUME or None,
            "prior_best_loss": None if PREV_BEST_LOSS == float("inf") else PREV_BEST_LOSS,
            "train_source": "training/train_velnor_lora.py:TRAIN",
            "heldout_source": "training/train_velnor_lora.py:HELDOUT",
        },
        "parameters": {"trainable": trainable, "total": total_params},
            "validation": {
                "pre_training_loss": round(pre_val_loss, 5),
                "best_loss": round(best_loss, 5),
                "best_epoch": best_epoch,
                "history": history,
                "early_stopping": {
                    "patience": PATIENCE,
                    "epochs_run": epochs_run,
                    "stopped_early": stopped_early,
                },
            },
        "rubric": {
            "base": base_eval,
            "tuned": tuned_eval,
            "delta_passed": tuned_eval["passed"] - base_eval["passed"],
        },
        "elapsed_seconds": round(time.time() - started, 2),
        "adapter_path": str(best_dir),
    }
    (OUT / "training_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
