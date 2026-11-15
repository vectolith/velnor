import ast
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

    def test_foundations_remain_unselected_until_validation(self):
        tiers = self.contract["tiers"]
        self.assertIsNone(tiers["prime"]["base_model"])
        self.assertIsNone(tiers["prima"]["base_model"])
        self.assertEqual(tiers["prime"]["foundation_status"], "unselected")
        self.assertEqual(tiers["prima"]["foundation_status"], "unselected")
        self.assertTrue(self.contract["selection_policy"]["training_blocked_until_foundation_validation"])

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

    def test_both_curricula_match_generic_trainer_schema_and_are_architecture_neutral(self):
        for filename in ("core_prime_curriculum.jsonl", "core_prima_curriculum.jsonl"):
            rows = [
                json.loads(line)
                for line in (ROOT / filename).read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertTrue(rows, filename)
            self.assertTrue(all(row.get("id") for row in rows), filename)
            self.assertTrue(all(row.get("split") in {"train", "validation"} for row in rows), filename)
            self.assertTrue(any(row["split"] == "train" for row in rows), filename)
            self.assertTrue(any(row["split"] == "validation" for row in rows), filename)
            ids = [row["id"] for row in rows]
            self.assertEqual(len(ids), len(set(ids)), filename)
            train_prompts = {row["prompt"] for row in rows if row["split"] == "train"}
            validation_prompts = {row["prompt"] for row in rows if row["split"] == "validation"}
            self.assertFalse(train_prompts & validation_prompts, filename)
            for row in rows:
                if row["domain"] in {"identity", "family_identity"}:
                    self.assertNotRegex(row["answer"], r"Qwen3-(?:8B|14B)")

    def test_family_evaluator_uses_immutable_foundation_revisions(self):
        source = (ROOT / "evaluate_velnor_family.py").read_text(encoding="utf-8")
        self.assertIn("revision=revision", source)
        self.assertIn("prime_selection[\"revision\"]", source)
        self.assertIn("prima_selection[\"revision\"]", source)

    def test_prima_curriculum_contains_advanced_objectives(self):
        domains = {row["domain"] for row in self.rows}
        self.assertTrue({"reasoning", "technical", "planning", "analysis",
                         "tool_use", "reliability", "security", "synthesis"} <= domains)

    def test_legacy_qwen_trainers_require_explicit_validated_selection(self):
        for name, tier in (("train_qwen3_8b_qlora.py", "prime"),
                           ("train_velnor_lora.py", "prime"),
                           ("train_core_prima_qwen3_14b.py", "prima")):
            source = (ROOT / name).read_text(encoding="utf-8")
            self.assertIn('assert_contract_matches_selection("' + tier + '")', source)
            self.assertIn("Use train_selected_adapter.py", source)

    def test_legacy_trainers_load_the_selected_immutable_revision(self):
        for name in ("train_qwen3_8b_qlora.py", "train_core_prima_qwen3_14b.py",
                     "train_velnor_lora.py"):
            source = (ROOT / name).read_text(encoding="utf-8")
            self.assertIn('revision=selected["revision"]', source, name)

    def test_generic_trainer_is_foundation_configurable_and_gated(self):
        source = (ROOT / "train_selected_adapter.py").read_text(encoding="utf-8")
        self.assertIn("assert_contract_matches_selection(args.tier)", source)
        self.assertIn("AutoModelForCausalLM.from_pretrained", source)
        self.assertIn("discover_lora_targets", source)
        self.assertIn("import math", source)
        self.assertIn("args.gradient_accumulation", source)


    def test_runtime_injects_correct_tier_metadata_with_shared_prompt(self):
        import sys
        sys.path.insert(0, str(ROOT))
        from family_runtime import family_system_prompt, release_metadata
        prime_prompt = family_system_prompt("prime")
        prima_prompt = family_system_prompt("prima")
        self.assertIn("VELNOR Core Prime", prime_prompt)
        self.assertIn("not yet selected", prime_prompt)
        self.assertIn("VELNOR Core Prima", prima_prompt)
        self.assertIn("not yet selected", prima_prompt)
        self.assertEqual(release_metadata("prime")["family"], "VELNOR")
        self.assertEqual(release_metadata("prima")["role"], "advanced_flagship")

    def test_all_training_and_runtime_python_files_parse(self):
        for name in ("train_core_prima_qwen3_14b.py", "train_selected_adapter.py",
                     "evaluate_velnor_family.py", "family_runtime.py",
                     "foundation_config.py", "train_velnor_lora.py"):
            with self.subTest(path=name):
                ast.parse((ROOT / name).read_text(encoding="utf-8"), filename=name)

    def test_family_evaluator_uses_same_generation_rubric(self):
        source = (ROOT / "evaluate_velnor_family.py").read_text(encoding="utf-8")
        self.assertIn("from grade_generations import CASES, grade_all", source)
        self.assertIn("comparison_complete_human_review_required", source)
        self.assertIn('"eligible": False', source)


if __name__ == "__main__":
    unittest.main()
