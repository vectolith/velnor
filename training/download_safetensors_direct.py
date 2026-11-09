"""Resilient direct HTTP stream downloader with auto-retry and Range resume for Qwen2.5-Coder-1.5B model.safetensors."""
import os
import sys
import time
import urllib.request
from pathlib import Path

URL = "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct/resolve/main/model.safetensors"
DEST = Path(__file__).resolve().parent / "models" / "qwen2.5-coder-1.5b" / "model.safetensors"
TOTAL_BYTES = 3087467144  # exact byte size from CDN headers


def download():
    DEST.parent.mkdir(parents=True, exist_ok=True)
    chunk_size = 1024 * 512  # 512 KB

    while True:
        existing = DEST.stat().st_size if DEST.exists() else 0
        if existing >= TOTAL_BYTES:
            print(f"[Done] model.safetensors verified complete: {existing / 1e9:.2f} GB ({existing:,} bytes).", flush=True)
            break

        pct = 100.0 * existing / TOTAL_BYTES
        print(f"[Connecting] Resuming from {existing / 1e6:.1f} MB ({pct:.1f}%)...", flush=True)

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
        }
        if existing > 0:
            headers["Range"] = f"bytes={existing}-"

        try:
            req = urllib.request.Request(URL, headers=headers)
            t0 = time.time()
            last_print = t0
            downloaded = existing

            with urllib.request.urlopen(req, timeout=30) as resp, open(DEST, "ab" if existing > 0 else "wb") as f:
                while downloaded < TOTAL_BYTES:
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        print(f"[Notice] Stream ended at {downloaded / 1e6:.1f} MB. Reconnecting...", flush=True)
                        break
                    f.write(chunk)
                    downloaded += len(chunk)

                    now = time.time()
                    if now - last_print >= 5.0 or downloaded >= TOTAL_BYTES:
                        pct = 100.0 * downloaded / TOTAL_BYTES
                        mb = downloaded / 1e6
                        speed_mb = (downloaded - existing) / (max(0.1, now - t0) * 1e6)
                        rem_sec = (TOTAL_BYTES - downloaded) / max(0.1, speed_mb * 1e6)
                        print(
                            f"[{pct:5.1f}%] {mb:7.1f} MB / {TOTAL_BYTES/1e6:.0f} MB | {speed_mb:.2f} MB/s | ~{rem_sec/60:.1f}m left",
                            flush=True,
                        )
                        last_print = now
        except Exception as err:
            print(f"[Warning] Connection error ({err}). Retrying in 3 seconds...", flush=True)
            time.sleep(3)


if __name__ == "__main__":
    download()
