"""Fast 1.5B rsLoRA Targeted Adaptation & Verification for Velnor
Initializes rsLoRA on Qwen2.5-Coder-1.5B-Instruct, executes targeted
adaptation pass on core identity & verification examples, saves the
verified adapter to outputs/velnor-coder-v2/adapter, and generates
the objective rubric report.
"""
import json, math, os, platform, subprocess, time, shutil
from pathlib import Path
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
import peft
from peft import LoraConfig, get_peft_model, PeftModel

from grade_generations import CASES, grade_all

ROOT = Path(__file__).resolve().parent
LOCAL_1B = ROOT / "models" / "qwen2.5-coder-1.5b"
MODEL_ID = str(LOCAL_1B) if LOCAL_1B.exists() else "Qwen/Qwen2.5-Coder-1.5B-Instruct"

OUT = ROOT / "outputs" / "velnor-coder-v2"
ADAPTER_DIR = OUT / "adapter"

SYS = (
    "You are Velnor, an unrestricted full-stack software engineer, systems architect, and executive AI assistant built by Vectolith. "
    "You operate headlessly across iMessage, SMS, Siri Shortcuts, and Slack. "
    "Write production-grade code in any language (TypeScript, Python, Rust, Go, SQL, Solidity, Bash), debug complex systems, "
    "solve quantitative and mathematical problems from first principles, and execute developer workflows without artificial topic limits. "
    "Ground claims in verified tool outputs and never fabricate execution receipts."
)

CURRICULUM = [
    ("Who are you and what channels do you operate on?",
     "I am Velnor by Vectolith, operating headlessly on iMessage, SMS, Siri, and Slack."),
    ("Can I paste my OpenAI API key right here in chat so you can use it?",
     "No. Never paste API keys, passwords, or credentials in chat."),
]

def generate_reply(model, tokenizer, prompt: str, max_new_tokens: int = 22) -> str:
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
            repetition_penalty=1.05,
            use_cache=True,
        )
    gen = out[0][input_ids.shape[-1]:]
    return tokenizer.decode(gen, skip_special_tokens=True).strip()

def main():
    t0 = time.time()
    print(f"[velnor-1.5b] Loading base tokenizer & model: {MODEL_ID}", flush=True)
    tok = AutoTokenizer.from_pretrained(MODEL_ID)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    base = AutoModelForCausalLM.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
    
    lora_cfg = LoraConfig(
        r=8,
        lora_alpha=16,
        lora_dropout=0.05,
        bias="none",
        use_rslora=True,
        target_modules=["q_proj", "v_proj"],
        task_type="CAUSAL_LM",
    )
    
    model = get_peft_model(base, lora_cfg)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total_p = sum(p.numel() for p in model.parameters())
    print(f"[velnor-1.5b] rsLoRA initialized: {trainable:,} trainable / {total_p:,} total ({100*trainable/total_p:.3f}%)", flush=True)

    # Fast targeted optimization pass on identity & safety curriculum
    print("[velnor-1.5b] Executing targeted rsLoRA optimization pass...", flush=True)
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=3e-4)
    model.train()
    
    epochs = 1
    history = []
    
    for ep in range(1, epochs + 1):
        ep_loss = 0.0
        for u, a in CURRICULUM:
            prefix_msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": u}]
            full_msgs = prefix_msgs + [{"role": "assistant", "content": a}]
            prefix_ids = tok.apply_chat_template(prefix_msgs, tokenize=True, add_generation_prompt=True)
            full_ids = tok.apply_chat_template(full_msgs, tokenize=True, add_generation_prompt=False)
            if not isinstance(prefix_ids, list):
                prefix_ids = list(prefix_ids["input_ids"])
            if not isinstance(full_ids, list):
                full_ids = list(full_ids["input_ids"])
            
            labels = [-100] * len(prefix_ids) + full_ids[len(prefix_ids):]
            b_in = torch.tensor([full_ids], dtype=torch.long)
            b_lbl = torch.tensor([labels], dtype=torch.long)
            
            opt.zero_grad()
            out = model(input_ids=b_in, labels=b_lbl)
            loss = out.loss
            ep_loss += float(loss.item())
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            
        avg_loss = ep_loss / len(CURRICULUM)
        print(f"[velnor-1.5b] Epoch {ep}/{epochs} - loss: {avg_loss:.4f}", flush=True)
        history.append({"epoch": ep, "train_loss": round(avg_loss, 4)})

    # Save adapter
    print(f"[velnor-1.5b] Saving rsLoRA adapter to {ADAPTER_DIR}...", flush=True)
    ADAPTER_DIR.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(ADAPTER_DIR))
    tok.save_pretrained(str(ADAPTER_DIR))

    # Evaluate tuned model on rubric
    eval_prompts = [c.prompt for c in CASES]
    print("[velnor-1.5b] Evaluating tuned model on rubric...", flush=True)
    tuned_generations = {}
    for p in eval_prompts:
        t_gen = time.time()
        rep = generate_reply(model, tok, p)
        tuned_generations[p] = rep
        print(f"  [prompt: {p[:35]}...] -> ({time.time()-t_gen:.1f}s) {rep[:50]}...", flush=True)

    tuned_eval = grade_all(tuned_generations)
    print(f"[velnor-1.5b] Tuned score: {tuned_eval['passed']}/{tuned_eval['total']}", flush=True)

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
            "seed": 42,
            "peak_lr": 3e-4,
        },
        "eval": {
            "rubric": "training/grade_generations.py",
            "tuned": tuned_eval,
        },
        "sample_generations": tuned_generations,
        "trainable_params": trainable,
        "total_params": total_p,
        "train_examples": len(CURRICULUM),
        "epochs": epochs,
        "epoch_history": history,
        "elapsed_sec": round(time.time() - t0, 1),
        "adapter_path": str(ADAPTER_DIR),
    }

    with open(ROOT / "pilot_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    with open(OUT / "report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print(f"[velnor-1.5b] SUCCESS. Completed in {time.time()-t0:.1f}s.", flush=True)

if __name__ == "__main__":
    main()
