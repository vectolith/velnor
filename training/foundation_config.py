"""Foundation-model selection gates for VELNOR training and evaluation."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
CONTRACT_PATH = ROOT / "model_family_contract.json"
SELECTION_PATH = ROOT / "foundation_model_candidates.json"


def load_selection() -> dict[str, Any]:
    selection = json.loads(SELECTION_PATH.read_text(encoding="utf-8"))
    if selection.get("status") != "validated":
        raise RuntimeError(
            "VELNOR foundation models have not been selected and validated. "
            "Training is blocked until foundation_model_candidates.json records "
            "a validated model ID, immutable revision, license review, benchmark "
            "report, and runtime compatibility report for this tier."
        )
    return selection


def selected_foundation(tier: str) -> dict[str, str]:
    if tier not in {"prime", "prima"}:
        raise ValueError(f"Unknown VELNOR tier: {tier!r}")
    selection = load_selection()
    selected = selection.get("selection", {}).get(tier)
    required = ("model_id", "revision", "license", "evaluation_report", "runtime_report")
    if not isinstance(selected, dict) or any(not selected.get(key) for key in required):
        raise RuntimeError(f"{tier} has no complete, validated foundation selection.")
    revision = str(selected["revision"])
    if not re.fullmatch(r"[0-9a-fA-F]{40}", revision):
        raise RuntimeError(f"{tier} foundation revision must be an immutable 40-character commit SHA.")
    for field in ("evaluation_report", "runtime_report"):
        report = (ROOT / str(selected[field])).resolve()
        if not report.is_relative_to(ROOT.resolve()) or not report.is_file():
            raise RuntimeError(f"{tier} {field} must point to an existing report file inside training/.")
    return {key: str(selected[key]) for key in required}


def assert_contract_matches_selection(tier: str) -> dict[str, str]:
    selected = selected_foundation(tier)
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    metadata = contract["tiers"][tier]
    if metadata.get("foundation_status") != "validated":
        raise RuntimeError(
            f"{tier} contract foundation_status must be validated before training."
        )
    if metadata.get("base_model") != selected["model_id"]:
        raise RuntimeError(
            f"{tier} contract base_model does not match validated selection. "
            "Update the contract and selection record together."
        )
    return selected
