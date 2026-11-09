"""Local HTTP inference server for Velnor (velnor-coder-v2 rsLoRA adapter).
Exposes POST http://127.0.0.1:8099/v1/chat for live Velnor multi-domain reasoning,
quantitative analysis, software architecture, and security inference.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import torch
import transformers
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

# The system prompt must be byte-identical to the one used for training, so it is
# imported from the trainer instead of copied here.
from train_velnor_lora import SYS as SYSTEM_INSTRUCTION

ROOT = Path(__file__).resolve().parent
CANDIDATE_ADAPTERS = [
    ROOT / "outputs" / "velnor-coder-v2" / "adapter",  # current run
    ROOT / "outputs" / "velnor-core-v1" / "adapter",   # earlier run (legacy)
    ROOT / "outputs" / "velnor-behavior-pilot" / "adapter",
]
PORT = 8099

active_adapter = next((p for p in CANDIDATE_ADAPTERS if (p / "adapter_config.json").exists()), None)
if active_adapter is None:
    raise SystemExit("No trained Velnor adapter found under training/outputs. Run train_velnor_lora.py first.")
# Always load the exact base model the adapter was trained on
MODEL_ID = json.loads((active_adapter / "adapter_config.json").read_text(encoding="utf-8"))[
    "base_model_name_or_path"
]
MODEL_LABEL = f"{active_adapter.parent.name} ({MODEL_ID} + rsLoRA)"
print(f"Loading Velnor base model from {MODEL_ID} and rsLoRA adapter from {active_adapter}...", flush=True)
tokenizer = AutoTokenizer.from_pretrained(str(active_adapter))
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token
_LOAD_KW = {"dtype": torch.float32} if int(transformers.__version__.split(".")[0]) >= 5 else {"torch_dtype": torch.float32}
base_model = AutoModelForCausalLM.from_pretrained(MODEL_ID, **_LOAD_KW)
model = PeftModel.from_pretrained(base_model, str(active_adapter))
model.eval()
print(f"Velnor rsLoRA inference server ready on http://127.0.0.1:{PORT}/v1/chat", flush=True)


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
                    "domains": 12,
                    "adapter": str(active_adapter),
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
        max_new_tokens = min(int(body.get("max_new_tokens", 120)), 256)
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
            )
        reply = tokenizer.decode(
            gen_ids[0][input_ids.shape[-1]:], skip_special_tokens=True
        ).strip()
        response = json.dumps(
            {
                "reply": reply,
                "assistant": "Velnor",
                "model": MODEL_LABEL,
                "production_ready": True,
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(response)


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
