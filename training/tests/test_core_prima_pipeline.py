import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CorePrimaPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = json.loads((ROOT / "model_family_contract.json").read_text(encoding="utf-8"))
        cls.rows = [
            json.loads(line)
            for line in (ROOT / "core_prima_curriculum.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_family_base_models_are_explicit_and_distinct(self):
        tiers = self.contract["tiers"]
        self.assertEqual(tiers["prime"]["base_model"], "Qwen/Qwen3-8B")
        self.assertEqual(tiers["prima"]["base_model"], "Qwen/Qwen3-14B")
        self.assertNotEqual(tiers["prime"]["base_model"], tiers["prima"]["base_model"])

    def test_shared_contract_is_tier_neutral(self):
        prompt = self.contract["shared_system_prompt"].lower()
        self.assertIn("velnor", prompt)
        self.assertIn("tier identity", prompt)
        self.assertNotIn("core prime is the flagship", prompt)
        self.assertNotIn("core prima is the flagship", prompt)

    def test_curriculum_has_unique_ids_and_nonempty_splits(self):
        ids = [row["id"] for row in self.rows]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(any(row["split"] == "train" for row in self.rows))
        self.assertTrue(any(row["split"] == "validation" for row in self.rows))
        self.assertTrue(all(row["domain"] and row["prompt"] and row["answer"] for row in self.rows))

    def test_train_and_validation_prompts_are_disjoint(self):
        train = {row["prompt"] for row in self.rows if row["split"] == "train"}
        valid = {row["prompt"] for row in self.rows if row["split"] == "validation"}
        self.assertTrue(train)
        self.assertTrue(valid)
        self.assertFalse(train & valid)

    def test_prima_curriculum_contains_advanced_objectives(self):
        domains = {row["domain"] for row in self.rows}
        self.assertTrue({"reasoning", "technical", "planning", "analysis",
                         "tool_use", "reliability", "security", "synthesis"} <= domains)

    def test_trainer_pins_qwen3_14b_and_fails_closed(self):
        source = (ROOT / "train_core_prima_qwen3_14b.py").read_text(encoding="utf-8")
        self.assertIn('MODEL_ID = "Qwen/Qwen3-14B"', source)
        self.assertIn("requires CUDA; CPU training is disabled", source)
        self.assertIn("No model was loaded and no training started", source)
        self.assertIn("Refusing to overwrite non-empty output directory", source)
        self.assertIn("No epoch improved held-out loss", source)


    def test_runtime_injects_correct_tier_metadata_with_shared_prompt(self):
        import sys
        sys.path.insert(0, str(ROOT))
        from family_runtime import family_system_prompt, release_metadata
        prime_prompt = family_system_prompt("prime")
        prima_prompt = family_system_prompt("prima")
        self.assertIn("VELNOR Core Prime", prime_prompt)
        self.assertIn("Qwen/Qwen3-8B", prime_prompt)
        self.assertIn("VELNOR Core Prima", prima_prompt)
        self.assertIn("Qwen/Qwen3-14B", prima_prompt)
        self.assertEqual(release_metadata("prime")["family"], "VELNOR")
        self.assertEqual(release_metadata("prima")["role"], "advanced_flagship")

    def test_family_evaluator_uses_same_generation_rubric(self):
        source = (ROOT / "evaluate_velnor_family.py").read_text(encoding="utf-8")
        self.assertIn("from grade_generations import CASES, grade_all", source)
        self.assertIn("comparison_complete_human_review_required", source)
        self.assertIn('"eligible": False', source)


if __name__ == "__main__":
    unittest.main()
