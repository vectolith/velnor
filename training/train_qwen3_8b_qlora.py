"""Free-GPU Qwen3-8B NF4 QLoRA training for Velnor.

This is adapter fine-tuning, not foundation-model pretraining. The base model is
intentionally fixed to Qwen/Qwen3-8B: adapters from other architectures are
rejected. Training requires a free CUDA GPU meeting the documented VRAM gate.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import random
import shutil
import subprocess
import time
from pathlib import Path

import bitsandbytes as bnb
import peft
import torch
import transformers
from peft import (
    PeftConfig,
    PeftModel,
    get_peft_model,
    prepare_model_for_kbit_training,
    LoraConfig,
)
from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

from train_velnor_lora import (
    TRAIN,
    HELDOUT,
    EXTRA_CURRICULUM,
    EXTRA_CURRICULUM_PATH,
    build_example,
    eval_loss,
    generate_reply,
)
from grade_generations import CASES, grade_all

MODEL_ID = "Qwen/Qwen3-8B"
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
SEED = 42
MAX_SEQ_LEN = int(os.environ.get("VELNOR_QWEN3_MAX_SEQ_LEN", "256"))
EPOCHS = int(os.environ.get("VELNOR_QWEN3_EPOCHS", "1"))
GRAD_ACCUM = int(os.environ.get("VELNOR_QWEN3_GRAD_ACCUM", "8"))
LR = float(os.environ.get("VELNOR_QWEN3_LR", "1e-4"))
PATIENCE = int(os.environ.get("VELNOR_QWEN3_PATIENCE", "1"))
MIN_TOTAL_VRAM_GIB = 14.0
MIN_FREE_VRAM_GIB = 12.0
OUT = Path(os.environ.get("VELNOR_QWEN3_OUTPUT", "outputs/qwen3-8b-qlora"))
RESUME = os.environ.get("VELNOR_QWEN3_RESUME", "").strip()
PREV_BEST_LOSS = os.environ.get("VELNOR_QWEN3_PREV_BEST_LOSS", "").strip()

random.seed(SEED)
torch.manual_seed(SEED)


def should_stop_early(stalled_epochs: int, patience: int) -> bool:
    """Stop after the configured number of consecutive non-improving epochs."""
    return patience > 0 and stalled_epochs >= patience


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_manifest(root: Path) -> None:
    entries = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.name != "SHA256SUMS":
            entries.append(f"{sha256_file(path)}  {path.relative_to(root).as_posix()}")
    (root / "SHA256SUMS").write_text("\n".join(entries) + "\n", encoding="utf-8")


def gpu_preflight() -> dict:
    if not torch.cuda.is_available() or torch.cuda.device_count() < 1:
        raise RuntimeError("A free CUDA GPU is required. CPU training is disabled.")
    props = torch.cuda.get_device_properties(0)
    free_bytes, _ = torch.cuda.mem_get_info(0)
    total_gib = props.total_memory / (1024 ** 3)
    free_gib = free_bytes / (1024 ** 3)
    if total_gib < MIN_TOTAL_VRAM_GIB or free_gib < MIN_FREE_VRAM_GIB:
        raise RuntimeError(
            f"GPU preflight failed: total={total_gib:.2f} GiB, free={free_gib:.2f} GiB; "
            f"requires {MIN_TOTAL_VRAM_GIB:.1f} GiB total and "
            f"{MIN_FREE_VRAM_GIB:.1f} GiB free. No training started."
        )
    return {
        "name": props.name,
        "total_vram_gib": round(total_gib, 2),
        "free_vram_gib": round(free_gib, 2),
        "cuda": torch.version.cuda,
        "bf16_supported": bool(torch.cuda.is_bf16_supported()),
    }


def validate_resume_adapter(path: Path) -> dict:
    if not path.is_dir():
        raise RuntimeError(f"Resume adapter directory does not exist: {path}")
    config_path = path / "adapter_config.json"
    weights = [path / "adapter_model.safetensors", path / "adapter_model.bin"]
    if not config_path.is_file() or not any(item.is_file() for item in weights):
        raise RuntimeError("Resume adapter is incomplete: config or weights are missing.")
    config = PeftConfig.from_pretrained(str(path))
    adapter_base = str(getattr(config, "base_model_name_or_path", "") or "").strip()
    required_targets = set(TARGET_MODULES)
    configured_targets = set(config.target_modules or [])
    if adapter_base != MODEL_ID:
        raise RuntimeError(
            f"Incompatible adapter base model {adapter_base!r}; expected {MODEL_ID!r}. "
            "Adapters are not transferable between Qwen3, Qwen2.5, and Llama."
        )
    if config.task_type != "CAUSAL_LM" or int(config.r) != 8 or not required_targets.issubset(configured_targets):
        raise RuntimeError("Resume adapter LoRA task, rank, or target modules do not match the Velnor Qwen3-8B training contract.")
    return {
        "base_model": adapter_base,
        "peft_type": str(config.peft_type),
        "task_type": str(config.task_type),
        "rank": int(config.r),
        "target_modules": sorted(configured_targets),
    }


def build_batches(tokenizer, examples):
    batches = []
    for user_text, assistant_text in examples:
        batch = build_example(tokenizer, user_text, assistant_text, MAX_SEQ_LEN)
        if batch["labels"].ne(-100).sum().item() == 0:
            raise ValueError(
                "An example has no assistant target tokens after truncation. "
                "Increase VELNOR_QWEN3_MAX_SEQ_LEN or shorten the source example."
            )
        batches.append(batch)
    return batches


def save_best_adapter(model, tokenizer, output_dir: Path, epoch: int) -> None:
    """Write an immutable epoch checkpoint, then atomically replace the selected adapter."""
    checkpoint_root = output_dir / "checkpoints"
    checkpoint_root.mkdir(parents=True, exist_ok=True)
    checkpoint = checkpoint_root / f"epoch-{epoch:03d}"
    if checkpoint.exists():
        raise RuntimeError(f"Checkpoint already exists; refusing overwrite: {checkpoint}")
    model.save_pretrained(checkpoint, safe_serialization=True)
    tokenizer.save_pretrained(checkpoint)
    if not (checkpoint / "adapter_config.json").is_file():
        raise RuntimeError("Checkpoint save did not produce adapter_config.json.")
    if not any((checkpoint / name).is_file() for name in ("adapter_model.safetensors", "adapter_model.bin")):
        raise RuntimeError("Checkpoint save did not produce adapter weights.")

    staged = output_dir / "adapter.next"
    selected = output_dir / "adapter"
    previous = output_dir / "adapter.previous"
    if staged.exists():
        shutil.rmtree(staged)
    shutil.copytree(checkpoint, staged)
    if previous.exists():
        shutil.rmtree(previous)
    if selected.exists():
        selected.replace(previous)
    try:
        staged.replace(selected)
    except Exception:
        if previous.exists() and not selected.exists():
            previous.replace(selected)
        raise
    if previous.exists():
        shutil.rmtree(previous)


def main() -> None:
    started = time.time()
    if EPOCHS < 1 or GRAD_ACCUM < 1 or MAX_SEQ_LEN < 128 or LR <= 0:
        raise ValueError("Invalid training configuration.")
    if PATIENCE < 0:
        raise ValueError("PATIENCE cannot be negative.")
    gpu = gpu_preflight()

    if (OUT / "adapter").exists() or (OUT / "training_report.json").exists():
        raise RuntimeError(f"Output already contains a completed/partial run: {OUT}")

    resume_info = None
    if RESUME:
        resume_info = validate_resume_adapter(Path(RESUME))

    model_config = AutoConfig.from_pretrained(MODEL_ID)
    if getattr(model_config, "model_type", None) != "qwen3":
        raise RuntimeError(
            f"Unexpected model architecture {getattr(model_config, 'model_type', None)!r}; "
            "the Qwen3-8B trainer will not substitute another model."
        )

    print("[qwen3-8b-e2] GPU:", json.dumps(gpu), flush=True)
    print("[qwen3-8b-e2] Loading Qwen3-8B with 4-bit NF4 QLoRA.", flush=True)
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

    targets = TARGET_MODULES
    module_names = {name.rsplit(".", 1)[-1] for name, _ in base.named_modules()}
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
        model = PeftModel.from_pretrained(base, RESUME, is_trainable=True)
        print(f"[qwen3-8b-e2] Resumed compatible adapter: {RESUME}", flush=True)
    else:
        model = get_peft_model(base, lora_config)

    model.print_trainable_parameters()
    trainable = sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad)
    total_params = sum(parameter.numel() for parameter in model.parameters())

    train_batches = build_batches(tokenizer, TRAIN)
    val_batches = build_batches(tokenizer, HELDOUT)
    if len(train_batches) != len(TRAIN) or len(val_batches) != len(HELDOUT):
        raise RuntimeError("Dataset batching changed example counts unexpectedly.")
    print(
        f"[qwen3-8b-e2] train={len(train_batches)} heldout={len(val_batches)} "
        f"seq_len={MAX_SEQ_LEN} grad_accum={GRAD_ACCUM} epochs={EPOCHS}",
        flush=True,
    )

    pre_val_loss = eval_loss(model, val_batches)
    eval_prompts = [case.prompt for case in CASES]
    with model.disable_adapter():
        base_generations = {prompt: generate_reply(model, tokenizer, prompt) for prompt in eval_prompts}
    base_eval = grade_all(base_generations)

    OUT.mkdir(parents=True, exist_ok=True)
    selected_dir = OUT / "adapter"
    if RESUME:
        shutil.copytree(Path(RESUME), selected_dir)
        tokenizer.save_pretrained(selected_dir)
    else:
        model.save_pretrained(selected_dir, safe_serialization=True)
        tokenizer.save_pretrained(selected_dir)

    # The old run's loss is historical metadata only. Selection always starts
    # from the resumed adapter's measured loss on this exact held-out split.
    best_loss = pre_val_loss
    best_epoch = 0
    stalled_epochs = 0
    stopped_early = False
    history = []
    steps_per_epoch = math.ceil(len(train_batches) / GRAD_ACCUM)
    total_steps = EPOCHS * steps_per_epoch
    warmup_steps = max(1, int(total_steps * 0.05))
    optimizer = bnb.optim.PagedAdamW8bit(
        [parameter for parameter in model.parameters() if parameter.requires_grad],
        lr=LR,
        weight_decay=0.01,
    )
    optimizer_step = 0

    for epoch in range(1, EPOCHS + 1):
        model.train()
        random.shuffle(train_batches)
        epoch_loss = 0.0
        optimizer.zero_grad(set_to_none=True)
        for index, batch in enumerate(train_batches, 1):
            batch = {key: value.to("cuda", non_blocking=True) for key, value in batch.items()}
            loss = model(**batch).loss
            epoch_loss += float(loss.detach().item())
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
                    [parameter for parameter in model.parameters() if parameter.requires_grad], 1.0
                )
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)

        val_loss = eval_loss(model, val_batches)
        improved = val_loss < best_loss
        if improved:
            best_loss = val_loss
            best_epoch = epoch
            stalled_epochs = 0
            save_best_adapter(model, tokenizer, OUT, epoch)
        else:
            stalled_epochs += 1

        history.append({
            "epoch": epoch,
            "train_loss": round(epoch_loss / len(train_batches), 6),
            "val_loss": round(val_loss, 6),
            "best": improved,
            "stalled_epochs": stalled_epochs,
        })
        print(
            f"[qwen3-8b-e2] epoch={epoch} train={epoch_loss / len(train_batches):.6f} "
            f"val={val_loss:.6f} best={improved} stalled={stalled_epochs}",
            flush=True,
        )
        if should_stop_early(stalled_epochs, PATIENCE):
            stopped_early = True
            print(f"[qwen3-8b-e2] early stopping at epoch {epoch}.", flush=True)
            break

    del optimizer, model, base
    torch.cuda.empty_cache()
    clean_base = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        quantization_config=quant_config,
        device_map={"": 0},
        low_cpu_mem_usage=True,
        attn_implementation="sdpa",
    )
    tuned_model = PeftModel.from_pretrained(clean_base, selected_dir)
    tuned_generations = {
        prompt: generate_reply(tuned_model, tokenizer, prompt) for prompt in eval_prompts
    }
    tuned_eval = grade_all(tuned_generations)

    try:
        git_commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parents[1],
            text=True,
        ).strip()
    except Exception:
        git_commit = None

    previous_loss_reference = None
    if PREV_BEST_LOSS:
        try:
            previous_loss_reference = float(PREV_BEST_LOSS)
        except ValueError:
            raise ValueError("VELNOR_QWEN3_PREV_BEST_LOSS must be numeric when supplied.")

    report = {
        "status": "completed",
        "training_type": "4-bit NF4 QLoRA adapter fine-tuning; not foundation-model pretraining",
        "base_model": MODEL_ID,
        "run": {"output_directory": str(OUT), "resumed_from": RESUME or None},
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
            "micro_batch_size": 1,
            "gradient_accumulation": GRAD_ACCUM,
            "max_sequence_length": MAX_SEQ_LEN,
            "epochs_requested": EPOCHS,
            "epochs_run": len(history),
            "early_stopping_patience": PATIENCE,
            "stopped_early": stopped_early,
            "learning_rate": LR,
        },
        "provenance": {
            "git_commit": git_commit,
            "trained_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "host": f"{platform.system()} {platform.machine()}",
            "gpu": gpu,
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "peft": peft.__version__,
            "bitsandbytes": getattr(bnb, "__version__", "unknown"),
            "seed": SEED,
        },
        "dataset": {
            "train_examples": len(TRAIN),
            "train_sha256": hashlib.sha256(json.dumps(TRAIN, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest(),
            "heldout_sha256": hashlib.sha256(json.dumps(HELDOUT, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest(),
            "heldout_examples": len(HELDOUT),
            "general_curriculum_examples": len(EXTRA_CURRICULUM),
            "general_curriculum_sha256": sha256_file(EXTRA_CURRICULUM_PATH),
            "train_source": "training/train_velnor_lora.py:TRAIN",
            "heldout_source": "training/train_velnor_lora.py:HELDOUT",
        },
        "resume": {
            "adapter_validation": resume_info,
            "previous_loss_reference_only": previous_loss_reference,
            "previous_loss_used_for_selection": False,
        },
        "parameters": {"trainable": trainable, "total": total_params},
        "validation": {
            "pre_training_loss": round(pre_val_loss, 6),
            "best_loss": round(best_loss, 6),
            "best_epoch": best_epoch,
            "history": history,
        },
        "rubric": {
            "case_count": len(CASES),
            "base": base_eval,
            "tuned": tuned_eval,
            "delta_passed": tuned_eval["passed"] - base_eval["passed"],
        },
        "promotion_gate": {
            "new_checkpoint_selected": best_epoch > 0,
            "heldout_loss_non_regression": best_loss <= pre_val_loss,
            "rubric_non_regression": tuned_eval["passed"] >= base_eval["passed"],
            "eligible_for_human_review": (
                best_epoch > 0 and best_loss <= pre_val_loss
                and tuned_eval["passed"] >= base_eval["passed"]
            ),
            "note": "This gate is a screening signal, not production certification.",
        },
        "base_generations": base_generations,
        "tuned_generations": tuned_generations,
        "elapsed_seconds": round(time.time() - started, 2),
        "adapter_path": str(selected_dir),
    }
    (OUT / "training_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    if not (selected_dir / "adapter_config.json").is_file():
        raise RuntimeError("Final selected adapter config is missing.")
    if not any((selected_dir / name).is_file() for name in ("adapter_model.safetensors", "adapter_model.bin")):
        raise RuntimeError("Final selected adapter weights are missing.")
    write_manifest(OUT)
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
