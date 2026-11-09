"""Download HuggingFaceTB/SmolLM2-135M-Instruct locally to models/smollm2-135m for offline CPU LoRA training."""
from pathlib import Path
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct"
TARGET_DIR = Path("models/smollm2-135m")


def main() -> None:
    if (TARGET_DIR / "config.json").exists() and (
        (TARGET_DIR / "model.safetensors").exists()
        or (TARGET_DIR / "pytorch_model.bin").exists()
    ):
        print(f"Base model already exists at {TARGET_DIR}. Skipping download.")
        return

    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {MODEL_ID} to {TARGET_DIR}...", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=False)
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, trust_remote_code=False)
    tokenizer.save_pretrained(TARGET_DIR)
    model.save_pretrained(TARGET_DIR)
    print(f"Saved {MODEL_ID} to {TARGET_DIR}.", flush=True)


if __name__ == "__main__":
    main()
