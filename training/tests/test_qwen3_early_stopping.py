"""Behavioural tests for the shipped Qwen3 E2 early-stopping and checkpoint rule."""
import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRAINER = ROOT / "train_qwen3_8b_qlora.py"


def load_helper(name):
    source = TRAINER.read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            namespace = {}
            module = ast.Module(body=[node], type_ignores=[])
            exec(compile(module, str(TRAINER), "exec"), namespace)
            return namespace[name]
    raise AssertionError(f"{name} not found")


class EarlyStoppingTests(unittest.TestCase):
    def test_patience_rule(self):
        stop = load_helper("should_stop_early")
        self.assertFalse(stop(0, 1))
        self.assertTrue(stop(1, 1))
        self.assertFalse(stop(1, 2))
        self.assertTrue(stop(2, 2))
        self.assertFalse(stop(100, 0))


class CheckpointSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = TRAINER.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source)

    def test_one_epoch_is_default_and_patience_is_configurable(self):
        self.assertIn('os.environ.get("VELNOR_QWEN3_EPOCHS", "1")', self.source)
        self.assertIn('os.environ.get("VELNOR_QWEN3_PATIENCE", "1")', self.source)

    def test_current_validation_split_is_the_only_selection_baseline(self):
        self.assertIn("best_loss = pre_val_loss", self.source)
        self.assertIn('"previous_loss_used_for_selection": False', self.source)

    def test_non_improving_epoch_does_not_write_selected_adapter(self):
        main = next(node for node in self.tree.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        loop = next(node for node in ast.walk(main) if isinstance(node, ast.For) and isinstance(node.target, ast.Name) and node.target.id == "epoch")
        if_node = next(node for node in loop.body if isinstance(node, ast.If) and ast.get_source_segment(self.source, node.test) == "improved")
        self.assertTrue(any(isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and getattr(node.value.func, "id", None) == "save_best_adapter" for node in if_node.body))
        self.assertTrue(any(isinstance(node, ast.AugAssign) and getattr(node.target, "id", None) == "stalled_epochs" for node in if_node.orelse))

    def test_resume_adapter_is_not_overwritten(self):
        self.assertIn("shutil.copytree(Path(RESUME), selected_dir)", self.source)
        self.assertIn("selected.replace(previous)", self.source)
        self.assertIn("previous.replace(selected)", self.source)


if __name__ == "__main__":
    unittest.main()
