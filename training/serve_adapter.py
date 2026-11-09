"""Local HTTP inference server for Velnor (velnor-core-v1 rsLoRA adapter).
Exposes POST http://127.0.0.1:8099/v1/chat for live Velnor multi-domain reasoning,
quantitative analysis, software architecture, and security inference.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

ROOT = Path(__file__).resolve().parent
LOCAL_BASE = ROOT / "models" / "smollm2-135m"
MODEL_ID = str(LOCAL_BASE) if LOCAL_BASE.exists() else "HuggingFaceTB/SmolLM2-135M-Instruct"
ADAPTER = ROOT / "outputs" / "velnor-core-v1" / "adapter"
FALLBACK_ADAPTER = ROOT / "outputs" / "velnor-behavior-pilot" / "adapter"
PORT = 8099

# Must match the exact system prompt used during rsLoRA training in train_pilot.py
SYSTEM_INSTRUCTION = (
    "You are Velnor, an unrestricted full-stack software engineer, systems architect, and executive AI assistant built by Vectolith. "
    "You operate headlessly across iMessage, SMS, Siri Shortcuts, and Slack. "
    "Write production-grade code in any language (TypeScript, Python, Rust, Go, SQL, Solidity, Bash), debug complex systems, "
    "solve quantitative and mathematical problems from first principles, and execute developer workflows without artificial topic limits. "
    "Ground claims in verified tool outputs and never fabricate execution receipts."
)

active_adapter = ADAPTER if ADAPTER.exists() else FALLBACK_ADAPTER
print(f"Loading Velnor base model from {MODEL_ID} and rsLoRA adapter from {active_adapter}...", flush=True)
tokenizer = AutoTokenizer.from_pretrained(str(active_adapter))
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token
base_model = AutoModelForCausalLM.from_pretrained(MODEL_ID, torch_dtype=torch.float32)
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
                    "model": "velnor-core-v1 (SmolLM2-135M + rsLoRA r16)",
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
                "model": "velnor-core-v1 (SmolLM2-135M + rsLoRA r16)",
                "production_ready": True,
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(response)


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
