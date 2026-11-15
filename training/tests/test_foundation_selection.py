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

    def test_unknown_tier_is_rejected(self):
        with self.assertRaises(ValueError):
            foundation_config.selected_foundation("unknown")


if __name__ == "__main__":
    unittest.main()
