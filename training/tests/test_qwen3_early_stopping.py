"""Behavioural tests for the Qwen3 QLoRA early-stopping rule.

torch/transformers are not installed in CI, so the trainer module cannot be
imported directly. We pull the real function source out of the real file with
ast and execute just that definition, so the assertions run the shipped code
rather than a copy of it.
"""
import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRAINER = ROOT / "train_qwen3_8b_qlora.py"


def _load_helper(name):
    source = TRAINER.read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            module = ast.Module(body=[node], type_ignores=[])
            namespace = {}
            exec(compile(module, str(TRAINER), "exec"), namespace)
            return namespace[name]
    raise AssertionError(f"{name} not found in {TRAINER}")


class EarlyStoppingTests(unittest.TestCase):
    def setUp(self):
        self.should_stop = _load_helper("should_stop_early")

    def test_disabled_when_patience_is_zero_or_negative(self):
        for patience in (0, -1, -5):
            for stalled in (0, 1, 3, 100):
                self.assertFalse(
                    self.should_stop(stalled, patience),
                    f"patience={patience} stalled={stalled} must not stop",
                )

    def test_stops_only_once_patience_is_reached(self):
        self.assertFalse(self.should_stop(0, 1))
        self.assertTrue(self.should_stop(1, 1))
        self.assertFalse(self.should_stop(1, 2))
        self.assertTrue(self.should_stop(2, 2))
        self.assertFalse(self.should_stop(2, 3))
        self.assertTrue(self.should_stop(3, 3))

    def test_is_monotonic_in_stalled_epochs(self):
        patience = 2
        results = [self.should_stop(n, patience) for n in range(0, 6)]
        self.assertEqual(results, [False, False, True, True, True, True])


class EarlyStoppingWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = TRAINER.read_text(encoding="utf-8")

    def test_patience_is_env_configurable_and_defaults_to_disabled(self):
        self.assertIn('os.environ.get("VELNOR_QWEN3_PATIENCE", "0")', self.source)

    def test_counter_resets_on_improvement_and_stops_the_loop(self):
        self.assertIn("stalled_epochs = 0", self.source)
        self.assertIn("stalled_epochs += 1", self.source)
        self.assertIn("if should_stop_early(stalled_epochs, PATIENCE):", self.source)
        self.assertIn("break", self.source)

    def test_report_records_early_stop_outcome(self):
        for token in ('"patience": PATIENCE', '"epochs_run": epochs_run',
                      '"stopped_early": stopped_early'):
            self.assertIn(token, self.source)

    def test_best_adapter_is_never_overwritten_by_a_worse_epoch(self):
        self.assertIn("if improved:", self.source)
        self.assertIn("model.save_pretrained(best_dir)", self.source)


if __name__ == "__main__":
    unittest.main()
