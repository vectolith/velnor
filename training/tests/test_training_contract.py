"""Dependency-free contract tests for the Velnor training entrypoint."""
import ast
import re
import unittest
from pathlib import Path

TRAINER = Path(__file__).resolve().parents[1] / "train_velnor_lora.py"
README = Path(__file__).resolve().parents[1] / "README.md"


class TrainingContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = TRAINER.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source)

    def test_canonical_base_is_qwen_and_legacy_auto_fallback_is_absent(self):
        self.assertIn('MODEL_REPO_ID = "Qwen/Qwen2.5-Coder-1.5B-Instruct"', self.source)
        self.assertNotIn("LOCAL_LEGACY", self.source)
        self.assertIn('os.environ.get("VELNOR_FAST_TRAIN", "0")', self.source)

    def test_full_curriculum_is_default_and_report_counts_selected_examples(self):
        self.assertIn('"train_examples": len(train_pool)', self.source)
        self.assertIn('"val_examples": len(val_pool)', self.source)
        self.assertIn('"full_train_examples": len(TRAIN)', self.source)
        self.assertIn('"full_val_examples": len(HELDOUT)', self.source)
        self.assertIn('"fast_mode": fast_mode', self.source)

    def test_training_data_is_literal_and_nonempty(self):
        assignment = next(
            node for node in self.tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "TRAIN"
                    for target in node.targets)
        )
        examples = ast.literal_eval(assignment.value)
        self.assertGreaterEqual(len(examples), 100)
        self.assertTrue(all(
            isinstance(item, tuple) and len(item) == 2
            and all(isinstance(part, str) and part.strip() for part in item)
            for item in examples
        ))

    def test_readme_describes_same_base_and_opt_in_fast_mode(self):
        readme = README.read_text(encoding="utf-8")
        self.assertIn("Qwen/Qwen2.5-Coder-1.5B-Instruct", readme)
        self.assertIn("VELNOR_FAST_TRAIN=1", readme)
        self.assertNotIn("SmolLM2-135M-Instruct", readme)


if __name__ == "__main__":
    unittest.main()
