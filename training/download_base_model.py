"""Download HuggingFaceTB/SmolLM2-135M-Instruct locally to models/smollm2-135m.

This is the base model named in the training README contract: 135.4M parameters,
trained on CPU in float32. Override at run time with VELNOR_BASE_MODEL.
"""
from pathlib import Path
from huggingface_hub import snapshot_download

MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct"
TARGET_DIR = Path(__file__).resolve().parent / "models" / "smollm2-135m"


def main() -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    weight_files = list(TARGET_DIR.glob("*.safetensors"))
    total_weight_bytes = sum(path.stat().st_size for path in weight_files)
    has_config = (TARGET_DIR / "config.json").is_file()
    # The 135M checkpoint is a single unsharded file, but validate the weight set
    # rather than assuming one name.
    if has_config and weight_files and total_weight_bytes > 250_000_000:
        print(
            f"Base model already exists at {TARGET_DIR} "
            f"({total_weight_bytes / 1e6:.1f} MB across {len(weight_files)} weight files). Skipping download."
        )
        return

    print(f"Downloading {MODEL_ID} to {TARGET_DIR}...", flush=True)
    snapshot_download(repo_id=MODEL_ID, local_dir=str(TARGET_DIR), max_workers=4)
    print(f"Successfully downloaded {MODEL_ID} to {TARGET_DIR}.", flush=True)


if __name__ == "__main__":
    main()
