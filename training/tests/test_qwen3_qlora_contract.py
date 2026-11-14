"""Static, dependency-free contract checks for Velnor Qwen3-8B E2."""
import ast
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRAINER = ROOT / "train_qwen3_8b_qlora.py"


class Qwen3E2ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = TRAINER.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source)

    def test_qwen3_base_and_fixed_adapter_architecture(self):
        self.assertIn('MODEL_ID = "Qwen/Qwen3-8B"', self.source)
        self.assertIn('getattr(model_config, "model_type", None) != "qwen3"', self.source)
        self.assertIn("adapter_base != MODEL_ID", self.source)
        self.assertIn("required_targets.issubset(configured_targets)", self.source)

    def test_uses_nf4_qlora_and_gradient_checkpointing(self):
        for token in ("BitsAndBytesConfig", "load_in_4bit=True",
                      'bnb_4bit_quant_type="nf4"', "bnb_4bit_use_double_quant=True",
                      "prepare_model_for_kbit_training", "PagedAdamW8bit"):
            self.assertIn(token, self.source)

    def test_free_gpu_only_preflight(self):
        for token in ("if not torch.cuda.is_available()", "MIN_TOTAL_VRAM_GIB = 14.0",
                      "MIN_FREE_VRAM_GIB = 12.0", "No training started."):
            self.assertIn(token, self.source)

    def test_uses_repository_curriculum_and_27_case_grader(self):
        self.assertIn("from train_velnor_lora import", self.source)
        self.assertIn("TRAIN,", self.source)
        self.assertIn("HELDOUT,", self.source)
        self.assertIn("from grade_generations import CASES, grade_all", self.source)
        self.assertIn('"train_examples": len(TRAIN)', self.source)
        self.assertIn('"heldout_examples": len(HELDOUT)', self.source)

    def test_provenance_and_artifact_integrity(self):
        for token in ('"git_commit"', '"train_sha256"', '"heldout_sha256"',
                      '"general_curriculum_sha256"', "training_report.json",
                      "write_manifest(OUT)", "SHA256SUMS"):
            self.assertIn(token, self.source)

    def test_requirements_do_not_replace_runtime_torch(self):
        req = (ROOT / "requirements-qwen3-qlora.txt").read_text(encoding="utf-8")
        self.assertIn("-r requirements-gpu.txt", req)
        self.assertIn("bitsandbytes", req)
        self.assertNotRegex(req, r"(?m)^\s*torch([<=>!~]|\s|$)")

    def test_e2_notebook_contract(self):
        path = ROOT / "Velnor_Qwen3_8B_QLoRA_E2.ipynb"
        notebook = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(notebook["nbformat"], 4)
        source = "\n".join("".join(cell.get("source", [])) for cell in notebook["cells"])
        self.assertIn("feat/qwen3-8b-qlora", source)
        self.assertIn("train_qwen3_8b_qlora.py", source)
        self.assertIn("VELNOR_QWEN3_RESUME", source)
        self.assertNotIn("GITHUB_TOKEN", source)
        self.assertNotIn("--force", source)
        self.assertNotIn("rm -rf", source)


if __name__ == "__main__":
    unittest.main()
