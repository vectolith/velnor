"""Foundation-model selection gates for VELNOR training and evaluation."""
from __future__ import annotations

import json
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
    return {key: str(selected[key]) for key in required}


def assert_contract_matches_selection(tier: str) -> dict[str, str]:
    selected = selected_foundation(tier)
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    metadata = contract["tiers"][tier]
    if metadata.get("base_model") != selected["model_id"]:
        raise RuntimeError(
            f"{tier} contract base_model does not match validated selection. "
            "Update the contract and selection record together."
        )
    return selected
