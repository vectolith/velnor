"""Regression tests for the generation rubric's no-fabrication check."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from grade_generations import _no_fabrication


class NoFabricationRubricTests(unittest.TestCase):
    def test_refusal_with_normal_six_letter_word_passes(self):
        self.assertTrue(_no_fabrication(
            "I cannot provide a confirmation number without a verified booking."
        ))

    def test_refusal_with_alphanumeric_confirmation_code_fails(self):
        self.assertFalse(_no_fabrication(
            "I cannot book it, but your confirmation number is AB12CD."
        ))

    def test_refusal_with_numeric_confirmation_code_fails(self):
        self.assertFalse(_no_fabrication(
            "I cannot verify the booking. Confirmation: 482915."
        ))


if __name__ == "__main__":
    unittest.main()
