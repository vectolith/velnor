"""Dependency-free contract tests for the Velnor training entrypoint."""
import ast
import json
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

    def test_cuda_training_moves_model_batches_and_generation_inputs(self):
        self.assertIn('torch.cuda.is_available()', self.source)
        self.assertIn('base.to(DEVICE)', self.source)
        self.assertIn('move_batch(b, DEVICE)', self.source)
        self.assertIn('input_ids = input_ids.to(next(model.parameters()).device)', self.source)
        self.assertIn('torch.cuda.is_bf16_supported()', self.source)

    def test_gpu_requirements_do_not_replace_cuda_torch(self):
        gpu_requirements = TRAIN.parent / "requirements-gpu.txt"
        requirements = gpu_requirements.read_text(encoding="utf-8")
        self.assertNotRegex(requirements, r"(?m)^\s*torch([<=>!~]|\s|$)")
        self.assertNotIn("download.pytorch.org/whl/cpu", requirements)
        self.assertIn("transformers==", requirements)
        self.assertIn("peft==", requirements)

    def test_colab_notebook_is_valid_and_persists_artifacts(self):
        notebook_path = TRAINER.parent / "Velnor_Qwen_1.5B_Colab.ipynb"
        notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
        self.assertEqual(notebook["nbformat"], 4)
        source = "\\n".join(
            "".join(cell.get("source", [])) for cell in notebook["cells"]
        )
        self.assertIn("torch.cuda.is_available()", source)
        self.assertIn("requirements-gpu.txt", source)
        self.assertIn("SHA256SUMS.json", source)
        self.assertIn("VELNOR_FAST_TRAIN=1", source) is False

    def test_readme_describes_same_base_and_opt_in_fast_mode(self):
        readme = README.read_text(encoding="utf-8")
        self.assertIn("Qwen/Qwen2.5-Coder-1.5B-Instruct", readme)
        self.assertIn("VELNOR_FAST_TRAIN=1", readme)
        self.assertIn("requirements-gpu.txt", readme)
        self.assertIn("Velnor_Qwen_1.5B_Colab.ipynb", readme)
        self.assertNotIn("SmolLM2-135M-Instruct", readme)


if __name__ == "__main__":
    unittest.main()
