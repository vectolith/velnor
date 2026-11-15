"""Download Qwen/Qwen2.5-Coder-1.5B-Instruct locally to models/qwen2.5-coder-1.5b for high-intelligence quantitative reasoning and coding."""
from pathlib import Path
from huggingface_hub import snapshot_download

MODEL_ID = "Qwen/Qwen2.5-Coder-1.5B-Instruct"
TARGET_DIR = Path(__file__).resolve().parent / "models" / "qwen2.5-coder-1.5b"


def main() -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    weight_files = list(TARGET_DIR.glob("*.safetensors"))
    total_weight_bytes = sum(path.stat().st_size for path in weight_files)
    has_config = (TARGET_DIR / "config.json").is_file()
    # Qwen snapshots may be sharded; validate the complete weight set rather
    # than assuming a single model.safetensors file exists.
    if has_config and weight_files and total_weight_bytes > 2_500_000_000:
        print(
            f"Base model already exists at {TARGET_DIR} "
            f"({total_weight_bytes / 1e9:.2f} GB across {len(weight_files)} weight files). Skipping download."
        )
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
