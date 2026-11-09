"""Download Qwen/Qwen2.5-Coder-1.5B-Instruct locally to models/qwen2.5-coder-1.5b for high-intelligence quantitative reasoning and coding."""
from pathlib import Path
from huggingface_hub import snapshot_download

MODEL_ID = "Qwen/Qwen2.5-Coder-1.5B-Instruct"
TARGET_DIR = Path(__file__).resolve().parent / "models" / "qwen2.5-coder-1.5b"


def main() -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    safetensors_file = TARGET_DIR / "model.safetensors"
    if safetensors_file.exists() and safetensors_file.stat().st_size > 3_000_000_000:
        print(f"Base 1.5B model already exists at {TARGET_DIR} ({safetensors_file.stat().st_size / 1e9:.2f} GB). Skipping download.")
        return

    print(f"Downloading 1.5B quantitative reasoning model ({MODEL_ID}) to {TARGET_DIR}...", flush=True)
    snapshot_download(
        repo_id=MODEL_ID,
        local_dir=str(TARGET_DIR),
        max_workers=4,
    )
    print(f"Successfully downloaded {MODEL_ID} to {TARGET_DIR}.", flush=True)


if __name__ == "__main__":
    main()
