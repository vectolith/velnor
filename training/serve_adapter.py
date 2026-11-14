"""Local HTTP inference server for Velnor (experimental general-purpose instruction model + rsLoRA).
Exposes POST http://127.0.0.1:8099/v1/chat for experimental general-purpose assistance,
including education, business, research, creative, everyday, and technical tasks.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import torch
import transformers
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

# The system prompt must be byte-identical to the one used for training
from train_velnor_lora import SYS as SYSTEM_INSTRUCTION

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("VELNOR_PORT", 8099))

LOCAL_1B_2B = ROOT / "models" / "qwen2.5-1.5b-instruct"
LOCAL_LEGACY = ROOT / "models" / "smollm2-135m"

CANDIDATE_ADAPTERS = [ROOT / "outputs" / "velnor-general-v1" / "adapter"]


def select_model():
    if (LOCAL_1B_2B / "model.safetensors").exists() or (LOCAL_1B_2B / "config.json").exists():
        model_path = str(LOCAL_1B_2B)
        label = "Velnor General 1.5B (Qwen2.5-1.5B-Instruct)"
        is_1b_2b = True
    else:
        active_adapter = next((p for p in CANDIDATE_ADAPTERS if (p / "adapter_config.json").exists()), None)
        if active_adapter:
            cfg = json.loads((active_adapter / "adapter_config.json").read_text(encoding="utf-8"))
            model_path = cfg.get("base_model_name_or_path", str(LOCAL_LEGACY))
            label = f"{active_adapter.parent.name} ({model_path} + rsLoRA)"
            is_1b_2b = "1.5b" in model_path.lower() or "qwen" in model_path.lower()
        else:
            model_path = "Qwen/Qwen2.5-1.5B-Instruct"
            label = "Velnor General 1.5B Base"
            is_1b_2b = True

    return model_path, label, is_1b_2b


MODEL_PATH, MODEL_LABEL, IS_1B_2B = select_model()
print(f"[Velnor Server] Initializing {MODEL_LABEL} from {MODEL_PATH}...", flush=True)

active_adapter = next((p for p in CANDIDATE_ADAPTERS if (p / "adapter_config.json").exists()), None)
if active_adapter and not IS_1B_2B:
    tokenizer = AutoTokenizer.from_pretrained(str(active_adapter))
else:
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)

if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

load_dtype = torch.bfloat16 if IS_1B_2B else torch.float32
_LOAD_KW = {"dtype": load_dtype} if int(transformers.__version__.split(".")[0]) >= 5 else {"torch_dtype": load_dtype}

base_model = AutoModelForCausalLM.from_pretrained(MODEL_PATH, **_LOAD_KW)

adapter_dir = ROOT / "outputs" / "velnor-general-v1" / "adapter"
if (adapter_dir / "adapter_config.json").exists():
    try:
        model = PeftModel.from_pretrained(base_model, str(adapter_dir))
        MODEL_LABEL += " + Adapter"
    except Exception as e:
        print(f"[Velnor Server] Adapter load skipped ({e}), running base directly.", flush=True)
        model = base_model
elif active_adapter:
    try:
        model = PeftModel.from_pretrained(base_model, str(active_adapter))
        MODEL_LABEL += " + Adapter"
    except Exception as e:
        print(f"[Velnor Server] Adapter load skipped ({e}), running base directly.", flush=True)
        model = base_model
else:
    model = base_model

model.eval()
print(f"[Velnor Server] Ready at http://127.0.0.1:{PORT}/v1/chat serving {MODEL_LABEL}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        return

    def do_GET(self) -> None:
        if self.path == "/health":
            payload = json.dumps(
                {
                    "status": "ok",
                    "assistant": "Velnor",
                    "organization": "Vectolith",
                    "model": MODEL_LABEL,
                    "tier": "General-purpose 1.5B experimental model" if IS_1B_2B else "Compact experimental pilot",
                    "bfloat16": IS_1B_2B,
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:
        if self.path != "/v1/chat":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        message = str(body.get("message", "")).strip()
        context = str(body.get("context", "")).strip()
        max_new_tokens = min(int(body.get("max_new_tokens", 256)), 512)
        if not message:
            self.send_response(400)
            self.end_headers()
            return

        user_prompt = f"{message}\n\n[Verified Context]\n{context}" if context else message
        msgs = [
            {"role": "system", "content": SYSTEM_INSTRUCTION},
            {"role": "user", "content": user_prompt},
        ]
        enc = tokenizer.apply_chat_template(
            msgs, tokenize=True, add_generation_prompt=True, return_tensors="pt"
        )
        input_ids = enc if isinstance(enc, torch.Tensor) else enc["input_ids"]
        with torch.no_grad():
            gen_ids = model.generate(
                input_ids=input_ids,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                repetition_penalty=1.08,
                pad_token_id=tokenizer.eos_token_id,
                eos_token_id=tokenizer.eos_token_id,
                use_cache=True,
            )
        reply = tokenizer.decode(
            gen_ids[0][input_ids.shape[-1]:], skip_special_tokens=True
        ).strip()
        response = json.dumps(
            {
                "reply": reply,
                "assistant": "Velnor",
                "model": MODEL_LABEL,
                "production_ready": False,
                "deployment_status": "experimental_unvalidated_checkpoint",
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(response)


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
