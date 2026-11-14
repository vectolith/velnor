"""Re-evaluate the saved Velnor LoRA adapter and write an honest report.

The training run writes its own report, but on a slow box it can be stopped
between epochs. This script measures the adapter that is actually on disk:
held-out loss, held-out perplexity, rubric-graded generations, provenance, and
the epoch curve recovered from the training log when one is given.

    python evaluate_adapter.py --log train.log --pre-val-loss 3.0473
"""

import argparse, json, math, os, platform, re, subprocess, sys, time
from pathlib import Path

import peft
import torch
import transformers
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

from grade_generations import CASES, grade_all
from train_velnor_lora import (
    HELDOUT, OUT, ROOT, SEED, SYS, TRAIN, build_example, curriculum_report,
    eval_loss, generate_reply, make_minibatches,
)


def epoch_history_from_log(path: Path):
    history = []
    pattern = re.compile(
        r"Epoch (\d+)/(\d+) \| train_loss=([\d.]+) \| val_loss=([\d.]+) \| val_ppl=([\d.]+)(.*)"
    )
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = pattern.search(line)
        if not m:
            continue
        history.append({
            "epoch": int(m.group(1)),
            "train_loss": float(m.group(3)),
            "val_loss": float(m.group(4)),
            "val_perplexity": float(m.group(5)),
            "is_best_checkpoint": "[BEST SAVED]" in m.group(6),
        })
    return history


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default=str(OUT / "adapter"))
    ap.add_argument("--log", default=None)
    ap.add_argument("--pre-val-loss", type=float, default=None)
    ap.add_argument("--out", default=str(ROOT / "pilot_report.json"))
    args = ap.parse_args()

    adapter_dir = Path(args.adapter)
    if not (adapter_dir / "adapter_config.json").exists():
        sys.exit(f"no adapter at {adapter_dir}")

    cfg = json.loads((adapter_dir / "adapter_config.json").read_text(encoding="utf-8"))
    base_id = cfg.get("base_model_name_or_path")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    dtype = (
        torch.bfloat16 if device.type == "cuda" and torch.cuda.is_bf16_supported()
        else torch.float16 if device.type == "cuda"
        else torch.float32
    )
    load_kw = {"dtype": dtype} if int(transformers.__version__.split(".")[0]) >= 5 else {"torch_dtype": dtype}

    tok = AutoTokenizer.from_pretrained(str(adapter_dir))
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    base = AutoModelForCausalLM.from_pretrained(base_id, **load_kw)
    base.to(device)
    base.eval()

    # Measure the untuned base model on the same held-out set and rubric, so the
    # report never has to carry a number forward from an earlier run.
    val_batches = [build_example(tok, u, a) for u, a in HELDOUT]
    base_val_loss = eval_loss(base, val_batches)
    base_generations = {c.prompt: generate_reply(base, tok, c.prompt) for c in CASES}
    base_eval = grade_all(base_generations)

    model = PeftModel.from_pretrained(base, str(adapter_dir))
    model.eval()

    trainable = sum(p.numel() for n, p in model.named_parameters() if "lora_" in n)
    total_p = sum(p.numel() for p in model.parameters())

    val_loss = eval_loss(model, val_batches)
    val_ppl = math.exp(min(20.0, val_loss))

    prompts = [c.prompt for c in CASES]
    generations = {p: generate_reply(model, tok, p) for p in prompts}
    tuned_eval = grade_all(generations)

    history = epoch_history_from_log(Path(args.log)) if args.log else []
    best = [h for h in history if h["is_best_checkpoint"]]
    best_epoch = best[-1]["epoch"] if best else None

    try:
        git_commit = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=str(ROOT), text=True
        ).strip()
    except Exception:
        git_commit = None

    summary = curriculum_report()
    summary["domains_covered"] = len(summary["domains"])

    pre_val_loss = args.pre_val_loss if args.pre_val_loss is not None else base_val_loss
    report = {
        "model_name": adapter_dir.parent.name,
        "base_model": base_id,
        "method": (
            f"rsLoRA (r={cfg.get('r')}, alpha={cfg.get('lora_alpha')}, "
            f"dropout={cfg.get('lora_dropout')}, use_rslora={cfg.get('use_rslora')}, "
            f"{len(cfg.get('target_modules', []))} target modules: "
            f"{', '.join(cfg.get('target_modules', []))})"
        ),
        "provenance": {
            "git_commit": git_commit,
            "trained_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "host": f"{platform.system()} {platform.machine()}",
            "cpu_count": os.cpu_count(),
            "device": str(device),
            "dtype": str(dtype).replace("torch.", ""),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "peft": peft.__version__,
            "seed": SEED,
            "report_source": "adapter re-evaluated from disk" + (f"; curve from {args.log}" if args.log else ""),
        },
        "trainable_params": trainable,
        "total_params": total_p,
        "train_examples": len(TRAIN),
        "val_examples": len(HELDOUT),
        "domains_covered": summary["domains_covered"],
        "curriculum": summary,
        "epochs": len(history) or None,
        "best_checkpoint_epoch": best_epoch,
            "pre_val_loss": round(pre_val_loss, 4),
            "pre_val_perplexity": round(math.exp(min(20.0, pre_val_loss)), 2),
        "post_val_loss": round(val_loss, 4),
        "post_val_perplexity": round(val_ppl, 2),
        "loss_reduction_pct": (
            round(100.0 * (pre_val_loss - val_loss) / pre_val_loss, 2) if pre_val_loss else None
        ),
        "epoch_history": history,
            "eval": {
                "rubric": "training/grade_generations.py",
                "base": base_eval,
                "tuned": tuned_eval,
                "rubric_pass_delta": tuned_eval["passed"] - base_eval["passed"],
            },
            "base_generations": base_generations,
        "sample_generations": generations,
        "adapter_path": str(adapter_dir),
    }

    Path(args.out).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (OUT / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
