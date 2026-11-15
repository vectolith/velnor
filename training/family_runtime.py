"""Runtime helpers for the versioned VELNOR model-family contract."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
CONTRACT_PATH = ROOT / "model_family_contract.json"


def load_family_contract() -> dict[str, Any]:
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    if contract.get("family") != "VELNOR" or not contract.get("contract_version"):
        raise ValueError("Invalid VELNOR model-family contract.")
    return contract


def family_system_prompt(tier: str) -> str:
    """Return the shared behavioural prompt with verified tier metadata injected."""
    contract = load_family_contract()
    if tier not in contract["tiers"]:
        raise ValueError(f"Unknown VELNOR tier: {tier!r}")
    metadata = contract["tiers"][tier]
    return (
        contract["shared_system_prompt"]
        + f" Active VELNOR tier: {metadata['display_name']}."
        + f" Foundation model: {metadata['base_model']}."
        + f" Family contract version: {contract['contract_version']}."
    )


def release_metadata(tier: str) -> dict[str, str]:
    contract = load_family_contract()
    if tier not in contract["tiers"]:
        raise ValueError(f"Unknown VELNOR tier: {tier!r}")
    metadata = contract["tiers"][tier]
    return {
        "family": contract["family"],
        "family_contract_version": contract["contract_version"],
        "tier": tier,
        "display_name": metadata["display_name"],
        "base_model": metadata["base_model"],
        "role": metadata["role"],
    }
