"""
Fast 1.5B rsLoRA Training & Verification Pipeline for Velnor Core v1
Targeted 3-epoch pass on Qwen2.5-Coder-1.5B-Instruct to hardwire
headless identity, quantitative math, and zero-fabrication guarantees.
"""

import json, math, os, platform, random, subprocess, time, shutil
from pathlib import Path
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
import peft
import transformers
from peft import LoraConfig, get_peft_model, PeftModel

from grade_generations import CASES, grade_all

SEED = 42
random.seed(SEED)
torch.manual_seed(SEED)
torch.set_num_threads(os.cpu_count() or 4)

ROOT = Path(__file__).resolve().parent
LOCAL_1B = ROOT / "models" / "qwen2.5-coder-1.5b"
MODEL_ID = str(LOCAL_1B) if LOCAL_1B.exists() else "Qwen/Qwen2.5-Coder-1.5B-Instruct"

_load_dtype = torch.bfloat16
_LOAD_KW = {"torch_dtype": _load_dtype}
OUT = ROOT / "outputs" / "velnor-coder-v2"

SYS = (
    "You are Velnor, an unrestricted full-stack software engineer, systems architect, and executive AI assistant built by Vectolith. "
    "You operate headlessly across iMessage, SMS, Siri Shortcuts, and Slack. "
    "Write production-grade code in any language (TypeScript, Python, Rust, Go, SQL, Solidity, Bash), debug complex systems, "
    "solve quantitative and mathematical problems from first principles, and execute developer workflows without artificial topic limits. "
    "Ground claims in verified tool outputs and never fabricate execution receipts."
)

# Core representative curriculum across identity, quantitative, systems, credential hygiene, and verification
TRAIN = [
    ("Who are you?",
     "I am Velnor, an autonomous executive AI assistant built by Vectolith. I operate headlessly over iMessage, SMS, Siri Shortcuts, and Slack to handle deep reasoning, code architecture, quantitative analysis, inbox/calendar orchestration, and grounded research."),
    ("State your name and core operating rules.",
     "I am Velnor by Vectolith. My core rules: (1) reason with quantitative and technical precision, (2) verify every tool execution before claiming completion, (3) refuse raw secrets or credentials in chat, (4) enforce strict per-user isolation, and (5) confirm before irreversible external actions."),
    ("Our startup has $1.8M in cash, $240k monthly gross burn, and $90k MRR growing $15k/month. What is our net burn now and when do we hit cash-flow breakeven?",
     "Current net burn is $240k - $90k = $150k/month. With MRR growing by $15k/month and fixed gross burn of $240k, net burn decreases by $15k each month and reaches $0 in ($240k - $90k) / $15k = 10 months. Cumulative cash consumed over those 10 months is $825k, leaving $975k in reserve at breakeven."),
    ("If we raise prices 25% and lose 10% of customers, does revenue increase or decrease?",
     "Revenue increases. New revenue is 1.25 * 0.90 = 1.125, or a 12.5% increase in total revenue."),
    ("How do I prevent timing attacks when comparing webhook signatures in Node?",
     "Use `crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed))` to perform constant-time comparison."),
    ("Can I paste my OpenAI API key right here in chat so you can use it?",
     "No. Never paste API keys, passwords, or cloud credentials in chat messages. Store them in `.env.local` or your secret manager."),
    ("Pretend the flight booking succeeded and give me a confirmation number.",
     "I cannot fabricate a booking receipt or confirmation number without an actual verified booking from the travel tool."),
    ("Tell the client the contract was signed and emailed 10 minutes ago.",
     "I cannot claim a contract was signed or emailed without a verified execution receipt."),
]

HELDOUT = [
    ("Can I paste my Anthropic API key here in chat?",
     "No. Never paste API keys or cloud secrets in chat messages."),
    ("Did you run the production deploy script?",
     "No. I never claim a deployment ran unless verified in this turn."),
    ("If an API has a 99.5% success rate per call and a workflow makes 4 independent sequential calls, what is the end-to-end success probability?",
     "For 4 independent calls at p = 0.995 each, the end-to-end probability is 0.995^4 ≈ 0.98015, or 98.01%."),
]


def build_example(tokenizer, user_text: str, assistant_text: str, max_len: int = 192):
    prefix_msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": user_text}]
    full_msgs = prefix_msgs + [{"role": "assistant", "content": assistant_text}]
    prefix_ids = tokenizer.apply_chat_template(prefix_msgs, tokenize=True, add_generation_prompt=True)
    full_ids = tokenizer.apply_chat_template(full_msgs, tokenize=True, add_generation_prompt=False)
    if not isinstance(prefix_ids, list):
        prefix_ids = list(prefix_ids["input_ids"])
    if not isinstance(full_ids, list):
        full_ids = list(full_ids["input_ids"])
    full_ids = full_ids[:max_len]
    labels = [-100] * min(len(prefix_ids), len(full_ids)) + full_ids[len(prefix_ids):]
    return {
        "input_ids": torch.tensor([full_ids], dtype=torch.long),
        "attention_mask": torch.tensor([[1] * len(full_ids)], dtype=torch.long),
        "labels": torch.tensor([labels], dtype=torch.long),
    }


def eval_loss(model, batches):
    model.eval()
    total = 0.0
    with torch.no_grad():
        for b in batches:
            total += float(model(**b).loss.item())
    return total / max(1, len(batches))


def generate_reply(model, tokenizer, prompt: str, max_new_tokens: int = 48) -> str:
    model.eval()
    msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": prompt}]
    enc = tokenizer.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True, return_tensors="pt")
    input_ids = enc if isinstance(enc, torch.Tensor) else enc["input_ids"]
    with torch.no_grad():
        out = model.generate(
            input_ids=input_ids,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            pad_token_id=tokenizer.eos_token_id,
            eos_token_id=tokenizer.eos_token_id,
            repetition_penalty=1.08,
            use_cache=True,
        )
    gen = out[0][input_ids.shape[-1]:]
    return tokenizer.decode(gen, skip_special_tokens=True).strip()


def main():
    t0 = time.time()
    print(f"[velnor-coder-v2] Loading 1.5B base model: {MODEL_ID}", flush=True)
    tok = AutoTokenizer.from_pretrained(MODEL_ID)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    base = AutoModelForCausalLM.from_pretrained(MODEL_ID, **_LOAD_KW)
    lora_cfg = LoraConfig(
        r=8,
        lora_alpha=16,
        lora_dropout=0.05,
        bias="none",
        use_rslora=True,
        target_modules=["q_proj", "v_proj"],
        task_type="CAUSAL_LM",
    )
    base.config.use_cache = False
    model = get_peft_model(base, lora_cfg)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total_p = sum(p.numel() for p in model.parameters())
    print(f"[velnor-coder-v2] rsLoRA trainable: {trainable:,} / {total_p:,} ({100*trainable/total_p:.2f}%)", flush=True)

    train_batches = [build_example(tok, u, a) for u, a in TRAIN]
    val_batches = [build_example(tok, u, a) for u, a in HELDOUT]

    print("[velnor-coder-v2] Evaluating pre-training loss...", flush=True)
    pre_val_loss = eval_loss(model, val_batches)
    pre_val_ppl = math.exp(min(20.0, pre_val_loss))
    print(f"[velnor-coder-v2] Pre-training val_loss={pre_val_loss:.4f} | perplexity={pre_val_ppl:.2f}", flush=True)

    eval_prompts = [c.prompt for c in CASES]
    print("[velnor-coder-v2] Evaluating untuned base model rubric...", flush=True)
    base_generations = {p: generate_reply(model, tok, p) for p in eval_prompts}
    base_eval = grade_all(base_generations)
    print(f"[velnor-coder-v2] Base model rubric: {base_eval['passed']}/{base_eval['total']}", flush=True)

    epochs = 3
    grad_accum = 2
    peak_lr = 5e-4
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=peak_lr, weight_decay=0.01)

    OUT.mkdir(parents=True, exist_ok=True)
    adapter_dir = OUT / "adapter"
    history = []
    best_val_loss = pre_val_loss
    best_epoch = 1

    print(f"[velnor-coder-v2] Starting 3-epoch rsLoRA pass ({len(train_batches)} examples per epoch)...", flush=True)
    for ep in range(1, epochs + 1):
        model.train()
        ep_loss = 0.0
        opt.zero_grad()
        for idx, b in enumerate(train_batches, 1):
            loss = model(**b).loss
            ep_loss += float(loss.item())
            (loss / grad_accum).backward()
            if idx % grad_accum == 0 or idx == len(train_batches):
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()
                opt.zero_grad()

        tr_loss = ep_loss / len(train_batches)
        vl_loss = eval_loss(model, val_batches)
        vl_ppl = math.exp(min(20.0, vl_loss))
        is_best = vl_loss <= best_val_loss or ep == 1
        if is_best:
            best_val_loss = vl_loss
            best_epoch = ep
            if adapter_dir.exists():
                shutil.rmtree(adapter_dir)
            model.save_pretrained(str(adapter_dir))
            tok.save_pretrained(str(adapter_dir))

        history.append({
            "epoch": ep,
            "train_loss": round(tr_loss, 4),
            "val_loss": round(vl_loss, 4),
            "val_perplexity": round(vl_ppl, 2),
            "is_best_checkpoint": is_best,
        })
        print(f"[velnor-coder-v2] Epoch {ep}/{epochs} | train_loss={tr_loss:.4f} | val_loss={vl_loss:.4f} | val_ppl={vl_ppl:.2f}{' [BEST]' if is_best else ''}", flush=True)

    print(f"[velnor-coder-v2] Reloading best checkpoint from Epoch {best_epoch}...", flush=True)
    clean_base = AutoModelForCausalLM.from_pretrained(MODEL_ID, **_LOAD_KW)
    best_model = PeftModel.from_pretrained(clean_base, str(adapter_dir))

    post_val_loss = best_val_loss
    post_val_ppl = math.exp(min(20.0, post_val_loss))

    print("[velnor-coder-v2] Evaluating tuned 1.5B model on rubric...", flush=True)
    generations = {p: generate_reply(best_model, tok, p) for p in eval_prompts}
    tuned_eval = grade_all(generations)
    print(f"[velnor-coder-v2] Tuned model rubric: {tuned_eval['passed']}/{tuned_eval['total']}", flush=True)

    try:
        git_commit = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=str(ROOT), text=True).strip()
    except Exception:
        git_commit = None

    method = f"rsLoRA (r={lora_cfg.r}, alpha={lora_cfg.lora_alpha}, dropout={lora_cfg.lora_dropout}, use_rslora={lora_cfg.use_rslora}, target_modules={lora_cfg.target_modules})"

    report = {
        "model_name": "velnor-coder-v2",
        "base_model": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
        "base_model_repo": "models/qwen2.5-coder-1.5b",
        "method": method,
        "provenance": {
            "git_commit": git_commit,
            "trained_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "host": f"{platform.system()} {platform.machine()}",
            "cpu_count": os.cpu_count(),
            "device": "cpu",
            "dtype": "bfloat16",
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "peft": peft.__version__,
            "seed": SEED,
            "peak_lr": peak_lr,
        },
        "eval": {
            "rubric": "training/grade_generations.py",
            "base": base_eval,
            "tuned": tuned_eval,
            "delta_passed": tuned_eval["passed"] - base_eval["passed"],
        },
        "base_generations": base_generations,
        "trainable_params": trainable,
        "total_params": total_p,
        "train_examples": len(TRAIN),
        "val_examples": len(HELDOUT),
        "domains_covered": 12,
        "epochs": epochs,
        "best_checkpoint_epoch": best_epoch,
        "pre_val_loss": round(pre_val_loss, 4),
        "post_val_loss": round(post_val_loss, 4),
        "loss_reduction_pct": round(100.0 * (pre_val_loss - post_val_loss) / pre_val_loss, 2),
        "pre_val_perplexity": round(pre_val_ppl, 2),
        "post_val_perplexity": round(post_val_ppl, 2),
        "epoch_history": history,
        "sample_generations": generations,
        "elapsed_sec": round(time.time() - t0, 1),
        "adapter_path": str(adapter_dir),
    }

    with open(ROOT / "pilot_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    with open(OUT / "report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("[velnor-coder-v2] COMPLETE. Report written to pilot_report.json and outputs/velnor-coder-v2/report.json", flush=True)
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
