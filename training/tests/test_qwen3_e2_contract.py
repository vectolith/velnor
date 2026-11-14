"""Static contracts for the Velnor Qwen3-8B E2 training entrypoint."""
import ast
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRAINER = ROOT / "train_qwen3_8b_qlora.py"
NOTEBOOK = ROOT / "Velnor_Qwen3_8B_QLoRA_E2.ipynb"


class Qwen3E2ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = TRAINER.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source)

    def test_trainer_parses_and_uses_fixed_qwen3_base(self):
        self.assertIn('MODEL_ID = "Qwen/Qwen3-8B"', self.source)
        self.assertIn('getattr(model_config, "model_type", None) != "qwen3"', self.source)

    def test_free_gpu_gate_is_fail_closed(self):
        self.assertIn("if not torch.cuda.is_available()", self.source)
        self.assertIn("MIN_TOTAL_VRAM_GIB = 14.0", self.source)
        self.assertIn("MIN_FREE_VRAM_GIB = 12.0", self.source)
        self.assertIn("No training started.", self.source)

    def test_resume_rejects_cross_architecture_adapters(self):
        self.assertIn("PeftConfig.from_pretrained", self.source)
        self.assertIn("adapter_base != MODEL_ID", self.source)
        self.assertIn("Adapters are not transferable", self.source)

    def test_validation_uses_current_split_not_historical_loss(self):
        self.assertIn("best_loss = pre_val_loss", self.source)
        self.assertIn('"previous_loss_used_for_selection": False', self.source)

    def test_worse_epochs_never_overwrite_selected_adapter(self):
        tree = self.tree
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        source = ast.get_source_segment(self.source, main)
        self.assertIn("if improved:", source)
        self.assertIn("save_best_adapter(model, tokenizer, OUT, epoch)", source)
        self.assertIn("else:\n            stalled_epochs += 1", source)

    def test_reports_provenance_evaluation_and_hash_manifest(self):
        for token in (
            '"git_commit"', '"general_curriculum_sha256"', '"promotion_gate"',
            '"training_report.json"', 'write_manifest(OUT)', '"delta_passed"',
        ):
            self.assertIn(token, self.source)

    def test_notebook_is_valid_and_has_no_token_or_force_push_workflow(self):
        notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
        self.assertEqual(notebook["nbformat"], 4)
        source = "\n".join(
            "".join(cell.get("source", [])) for cell in notebook["cells"]
        )
        self.assertIn("feat/qwen3-8b-qlora", source)
        self.assertIn("train_qwen3_8b_qlora.py", source)
        self.assertIn("VELNOR_QWEN3_RESUME", source)
        self.assertNotIn("GITHUB_TOKEN", source)
        self.assertNotIn("--force", source)
        self.assertNotIn("rm -rf", source)


if __name__ == "__main__":
    unittest.main()
