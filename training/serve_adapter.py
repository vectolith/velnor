"""Lightweight local HTTP inference server for the Olli CPU LoRA behavior pilot adapter.
Exposes POST http://127.0.0.1:8099/v1/chat for local testing with Olli.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

BASE = Path("models/smollm2-135m")
ADAPTER = Path("outputs/olli-behavior-pilot/adapter")
PORT = 8099

print(f"Loading base model from {BASE} and LoRA adapter from {ADAPTER}...", flush=True)
tokenizer = AutoTokenizer.from_pretrained(BASE, local_files_only=True, trust_remote_code=False)
base_model = AutoModelForCausalLM.from_pretrained(
    BASE, local_files_only=True, trust_remote_code=False, dtype=torch.float32
)
model = PeftModel.from_pretrained(base_model, ADAPTER)
model.eval()
print(f"Olli LoRA pilot adapter ready on http://127.0.0.1:{PORT}/v1/chat", flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            payload = json.dumps({"status": "ok", "adapter": str(ADAPTER)}).encode("utf-8")
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
        if not message:
            self.send_response(400)
            self.end_headers()
            return
        prompt = tokenizer.apply_chat_template(
            [{"role": "user", "content": message}], tokenize=False, add_generation_prompt=True
        )
        inputs = tokenizer(prompt, return_tensors="pt", add_special_tokens=False)
        with torch.no_grad():
            gen_ids = model.generate(
                **inputs,
                max_new_tokens=64,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        reply = tokenizer.decode(
            gen_ids[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True
        ).strip()
        response = json.dumps(
            {
                "reply": reply,
                "model": "smollm2-135m+olli-behavior-pilot-lora",
                "production_ready": False,
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(response)


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
