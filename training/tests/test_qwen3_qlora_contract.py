"""Static, dependency-free contract checks for the Qwen3 QLoRA path."""
import ast
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRAINER = ROOT / "train_qwen3_8b_qlora.py"


class Qwen3QLoRAContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = TRAINER.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source)

    def test_target_is_qwen3_8b_and_baseline_is_not_replaced(self):
        self.assertIn('MODEL_ID = "Qwen/Qwen3-8B"', self.source)
        baseline = (ROOT / "train_velnor_lora.py").read_text(encoding="utf-8")
        self.assertIn('MODEL_REPO_ID = "Qwen/Qwen2.5-Coder-1.5B-Instruct"', baseline)

    def test_uses_real_4bit_nf4_qlora_primitives(self):
        for token in (
            "BitsAndBytesConfig", "load_in_4bit=True", 'bnb_4bit_quant_type="nf4"',
            "bnb_4bit_use_double_quant=True", "prepare_model_for_kbit_training",
            "gradient_checkpointing_kwargs", "get_peft_model", "PagedAdamW8bit",
        ):
            self.assertIn(token, self.source)

    def test_refuses_cpu_and_insufficient_gpu_memory(self):
        self.assertIn("if not torch.cuda.is_available()", self.source)
        self.assertIn("MIN_TOTAL_VRAM_GIB = 14.0", self.source)
        self.assertIn("MIN_FREE_VRAM_GIB = 12.0", self.source)
        self.assertIn("No training started.", self.source)

    def test_dataset_and_evaluation_are_shared_with_baseline(self):
        self.assertIn("from train_velnor_lora import", self.source)
        self.assertIn("TRAIN, HELDOUT, SYS", self.source)
        self.assertIn("from grade_generations import CASES, grade_all", self.source)
        self.assertIn('"train_examples": len(TRAIN)', self.source)
        self.assertIn('"heldout_examples": len(HELDOUT)', self.source)

    def test_reports_gpu_and_training_provenance(self):
        for token in ("git_commit", "trained_at_utc", "torch.__version__",
                      "transformers.__version__", "peft.__version__",
                      "training_report.json", "rubric", "elapsed_seconds"):
            self.assertIn(token, self.source)

    def test_qwen_module_targets_fail_closed(self):
        self.assertIn('targets = ["q_proj", "k_proj", "v_proj", "o_proj"', self.source)
        self.assertIn("if missing:", self.source)
        self.assertIn("raise RuntimeError", self.source)


    def test_gpu_requirements_keep_runtime_torch_and_add_bitsandbytes(self):
        req = (ROOT / "requirements-qwen3-qlora.txt").read_text(encoding="utf-8")
        self.assertIn("-r requirements-gpu.txt", req)
        self.assertIn("bitsandbytes", req)
        self.assertNotRegex(req, r"(?m)^\s*torch([<=>!~]|\s|$)")

    def test_colab_notebook_is_valid_and_uses_isolated_branch(self):
        path = ROOT / "Velnor_Qwen3_8B_QLoRA_Colab.ipynb"
        notebook = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(notebook["nbformat"], 4)
        source = " ".join("".join(c.get("source", [])) for c in notebook["cells"])
        self.assertIn("feat/qwen3-8b-qlora", source)
        self.assertIn("requirements-qwen3-qlora.txt", source)
        self.assertIn("VELNOR_QWEN3_OUTPUT", source)
        self.assertNotIn("reset --hard", source)


if __name__ == "__main__":
    unittest.main()
