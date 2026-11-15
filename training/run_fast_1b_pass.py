"""Compatibility entrypoint for the historical targeted 1.5B pass.

All current training logic is centralized in train_velnor_lora.py. This legacy
command now delegates to the same canonical trainer in explicit smoke mode.
"""
import os
import runpy
from pathlib import Path

os.environ.setdefault("VELNOR_FAST_TRAIN", "1")
runpy.run_path(str(Path(__file__).with_name("train_velnor_lora.py")), run_name="__main__")
