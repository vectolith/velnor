"""Compatibility entrypoint for an explicitly reduced Velnor training smoke run.

New training logic lives only in train_velnor_lora.py. This wrapper sets the
smoke-run flag and delegates to that canonical implementation so model,
curriculum, evaluation, and report logic cannot drift between scripts.
"""
import os
import runpy
from pathlib import Path

os.environ.setdefault("VELNOR_FAST_TRAIN", "1")
runpy.run_path(str(Path(__file__).with_name("train_velnor_lora.py")), run_name="__main__")
