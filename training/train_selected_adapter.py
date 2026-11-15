"""Architecture-configurable QLoRA adapter trainer for validated VELNOR foundations.

This trainer intentionally refuses to run until a tier has a validated foundation
selection in foundation_model_candidates.json. It creates tier-specific adapters;
it does not pretrain or merge foundation weights.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import time
from pathlib import Path

import torch
import bitsandbytes as bnb
import peft
import transformers
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

from family_runtime import family_system_prompt
from foundation_config import assert_contract_matches_selection

ROOT = Path(__file__).resolve().parent
CURRICULA = {"prime": ROOT / "core_prime_curriculum.jsonl",
             "prima": ROOT / "core_prima_curriculum.jsonl"}
SEED = 20261115


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def discover_lora_targets(model) -> list[str]:
    available = {name.rsplit(".", 1)[-1] for name, _ in model.named_modules()}
    groups = [
        ["q_proj", "k_proj", "v_proj", "o_proj"],
        ["query_key_value"],
        ["Wqkv"],
        ["c_attn"],
    ]
    attention = next((group for group in groups if set(group) <= available), None)
    if attention is None:
        raise RuntimeError(
            "Unsupported attention projection layout. Add an architecture-specific "
            "target mapping after reviewing this model's module names; refusing guesses."
        )
    mlp = [name for name in ("gate_proj", "up_proj", "down_proj", "fc1", "fc2")
           if name in available]
    if not mlp:
        raise RuntimeError("Unsupported MLP projection layout; add a reviewed architecture mapping.")
    return attention + mlp


def encode(tokenizer, row, system_prompt, max_length):
    messages = [{"role": "system", "content": system_prompt},
                {"role": "user", "content": row["prompt"]},
                {"role": "assistant", "content": row["answer"]}]
    ids = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=False)
    prefix = tokenizer.apply_chat_template(messages[:2], tokenize=True, add_generation_prompt=True)
    if len(ids) > max_length:
        raise ValueError(f"{row['id']} exceeds max_length={max_length}; silent truncation is disabled.")
    if len(prefix) >= len(ids):
        raise ValueError(f"{row['id']} has no assistant target tokens after chat-template masking.")
    labels = list(ids)
    labels[:len(prefix)] = [-100] * len(prefix)
    if all(token == -100 for token in labels):
        raise ValueError(f"{row['id']} has no trainable assistant tokens.")
    return {"input_ids": torch.tensor(ids), "labels": torch.tensor(labels)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", choices=("prime", "prima"), required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--max-length", type=int, default=1024)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--alpha", type=int, default=32)
    parser.add_argument("--gradient-accumulation", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=8e-5)
    args = parser.parse_args()

    # This gate executes before model download, GPU allocation, or training.
    selected = assert_contract_matches_selection(args.tier)
    model_id = selected["model_id"]
    curriculum = CURRICULA[args.tier]
    output = Path(args.output)
    if output.exists() and any(output.iterdir()):
        raise RuntimeError(f"Refusing to overwrite non-empty output directory: {output}")
    if not torch.cuda.is_available():
        raise RuntimeError("Release adapter training requires CUDA; CPU fallback is disabled.")
    if (args.epochs < 1 or args.max_length < 256 or args.rank < 1 or args.alpha < 1
            or args.gradient_accumulation < 1 or args.learning_rate <= 0):
        raise ValueError("Invalid training configuration.")
    if not curriculum.is_file():
        raise FileNotFoundError(curriculum)

    random.seed(SEED)
    torch.manual_seed(SEED)
    config = AutoConfig.from_pretrained(model_id, revision=selected["revision"])
    if getattr(config, "is_encoder_decoder", False):
        raise RuntimeError("Only decoder-only causal language models are supported by this trainer.")
    tokenizer = AutoTokenizer.from_pretrained(model_id, revision=selected["revision"])
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    rows = [json.loads(line) for line in curriculum.read_text(encoding="utf-8").splitlines() if line.strip()]
    train_rows = [row for row in rows if row.get("split") == "train"]
    valid_rows = [row for row in rows if row.get("split") == "validation"]
    if not train_rows or not valid_rows:
        raise ValueError("Both train and validation curriculum splits are required.")
    if {r["prompt"] for r in train_rows} & {r["prompt"] for r in valid_rows}:
        raise ValueError("Train/validation prompt leakage detected.")

    free, total = torch.cuda.mem_get_info(0)
    if free / 1024**3 < 12:
        raise RuntimeError(f"At least 12 GiB free VRAM is required; found {free/1024**3:.2f} GiB.")
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=dtype)
    model = AutoModelForCausalLM.from_pretrained(
        model_id, revision=selected["revision"], quantization_config=quant,
        device_map={"": 0}, low_cpu_mem_usage=True)
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False})
    targets = discover_lora_targets(model)
    model = get_peft_model(model, LoraConfig(
        r=args.rank, lora_alpha=args.alpha, lora_dropout=0.05,
        use_rslora=True, bias="none", target_modules=targets, task_type="CAUSAL_LM"))

    system = family_system_prompt(args.tier)
    train = [encode(tokenizer, row, system, args.max_length) for row in train_rows]
    valid = [encode(tokenizer, row, system, args.max_length) for row in valid_rows]
    optimizer = bnb.optim.PagedAdamW8bit(
        [p for p in model.parameters() if p.requires_grad], lr=args.learning_rate, weight_decay=0.01)

    def evaluate():
        model.eval()
        losses = []
        with torch.no_grad():
            for item in valid:
                batch = {k: v.unsqueeze(0).to("cuda") for k, v in item.items()}
                losses.append(float(model(**batch).loss.detach().cpu()))
        return sum(losses) / len(losses)

    initial_loss = evaluate()
    best_loss = initial_loss
    history = []
    started = time.time()
    steps_per_epoch = (len(train) + args.gradient_accumulation - 1) // args.gradient_accumulation
    total_steps = args.epochs * steps_per_epoch
    warmup_steps = max(1, int(total_steps * 0.05))
    optimizer_step = 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        order = list(range(len(train)))
        random.shuffle(order)
        optimizer.zero_grad(set_to_none=True)
        epoch_losses = []
        for index, item_index in enumerate(order, 1):
            batch = {k: v.unsqueeze(0).to("cuda") for k, v in train[item_index].items()}
            loss = model(**batch).loss
            epoch_losses.append(float(loss.detach().cpu()))
            group_start = ((index - 1) // args.gradient_accumulation) * args.gradient_accumulation
            group_size = min(args.gradient_accumulation, len(order) - group_start)
            (loss / group_size).backward()
            boundary = index % args.gradient_accumulation == 0 or index == len(order)
            if boundary:
                optimizer_step += 1
                if optimizer_step <= warmup_steps:
                    lr_now = args.learning_rate * optimizer_step / warmup_steps
                else:
                    progress = (optimizer_step - warmup_steps) / max(1, total_steps - warmup_steps)
                    lr_now = args.learning_rate * 0.1 + 0.5 * (args.learning_rate - args.learning_rate * 0.1) * (1 + math.cos(math.pi * progress))
                for group in optimizer.param_groups:
                    group["lr"] = lr_now
                torch.nn.utils.clip_grad_norm_(
                    [p for p in model.parameters() if p.requires_grad], 1.0)
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
        val_loss = evaluate()
        history.append({"epoch": epoch, "train_loss": sum(epoch_losses)/len(epoch_losses),
                        "validation_loss": val_loss})
        if val_loss < best_loss:
            best_loss = val_loss
            output.mkdir(parents=True, exist_ok=True)
            model.save_pretrained(output, safe_serialization=True)
            tokenizer.save_pretrained(output)

    if not (output / "adapter_config.json").is_file():
        raise RuntimeError("No checkpoint improved validation loss; no adapter artifact was selected.")
    report = {
        "status": "trained_candidate_not_promoted", "tier": args.tier,
        "display_name": "VELNOR Core Prime" if args.tier == "prime" else "VELNOR Core Prima",
        "base_model": model_id, "base_revision": selected["revision"],
        "family_contract_version": json.loads((ROOT / "model_family_contract.json").read_text())["contract_version"],
        "license_review": selected["license"], "evaluation_report": selected["evaluation_report"],
        "runtime_report": selected["runtime_report"], "training_method": "4-bit NF4 QLoRA with rsLoRA",
        "lora_target_modules": targets, "rank": args.rank, "alpha": args.alpha,
        "epochs": args.epochs, "max_length": args.max_length,
        "gradient_accumulation": args.gradient_accumulation, "learning_rate": args.learning_rate,
        "warmup_steps": warmup_steps,
        "curriculum_sha256": sha256(curriculum), "train_examples": len(train_rows),
        "validation_examples": len(valid_rows), "initial_validation_loss": initial_loss,
        "best_validation_loss": best_loss, "history": history,
        "gpu": torch.cuda.get_device_name(0), "gpu_total_vram_gib": round(total/1024**3, 2),
        "duration_seconds": round(time.time()-started, 2),
        "promotion": {"eligible": False,
            "reason": "Loss is not a capability benchmark. Run the paired family benchmark, hard-task evaluations, safety checks, and expert review."},
        "versions": {"torch": torch.__version__, "transformers": transformers.__version__,
                     "peft": peft.__version__, "bitsandbytes": getattr(bnb, "__version__", "unknown")}
    }
    (output / "training_report.json").write_text(json.dumps(report, indent=2) + "\n")
    manifest = []
    for file in sorted(output.rglob("*")):
        if file.is_file() and file.name != "SHA256SUMS":
            manifest.append(f"{sha256(file)}  {file.relative_to(output).as_posix()}")
    (output / "SHA256SUMS").write_text("\n".join(manifest) + "\n")
    print(json.dumps({"status": report["status"], "tier": args.tier,
                      "base_model": model_id, "output": str(output)}, indent=2))


if __name__ == "__main__":
    main()
