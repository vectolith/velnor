import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import foundation_config


class FoundationSelectionTests(unittest.TestCase):
    def test_unselected_foundations_block_training(self):
        with patch.object(foundation_config, "SELECTION_PATH",
                          Path(__file__).resolve().parents[1] / "foundation_model_candidates.json"):
            with self.assertRaisesRegex(RuntimeError, "have not been selected and validated"):
                foundation_config.selected_foundation("prime")

    def test_contract_must_mark_foundation_validated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selection_path = root / "selection.json"
            contract_path = root / "contract.json"
            selection_path.write_text(json.dumps({
                "status": "validated",
                "selection": {"prime": {
                    "model_id": "org/model",
                    "revision": "immutable-revision",
                    "license": "Apache-2.0",
                    "evaluation_report": "reports/evaluation.json",
                    "runtime_report": "reports/runtime.json"
                }}
            }), encoding="utf-8")
            contract_path.write_text(json.dumps({
                "tiers": {"prime": {
                    "base_model": "org/model",
                    "foundation_status": "unselected"
                }}
            }), encoding="utf-8")
            with patch.object(foundation_config, "SELECTION_PATH", selection_path), \\
                 patch.object(foundation_config, "CONTRACT_PATH", contract_path):
                with self.assertRaisesRegex(RuntimeError, "foundation_status must be validated"):
                    foundation_config.assert_contract_matches_selection("prime")

    def test_unknown_tier_is_rejected(self):
        with self.assertRaises(ValueError):
            foundation_config.selected_foundation("unknown")


if __name__ == "__main__":
    unittest.main()
