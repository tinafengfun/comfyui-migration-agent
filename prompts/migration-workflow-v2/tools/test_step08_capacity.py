#!/usr/bin/env python3
"""Unit tests for the Step 08 capacity/reduced-validation fixes (items 13-003 & 13-009).

Stdlib-only (``unittest``). Run from the tools/ directory:

    python3 -m unittest test_step08_capacity -v

These test the smallest pure seams extracted for the two fixes:
  * ``classify_reduced_validation``            -- tri-state VRAM-fit verdict (13-003)
  * ``merge_reduced_validation_into_aggregate``-- carry-forward merge (13-009)
  * ``summarize_history``                      -- cached-node parser guard (13-009)
"""

from __future__ import annotations

import unittest
from pathlib import Path

from step08_full_validation import (
    classify_reduced_validation,
    merge_reduced_validation_into_aggregate,
    infer_usable_budget_bytes,
)
from step07_branch_smoke import summarize_history


class TestInferUsableBudget(unittest.TestCase):
    """Budget denominator must reflect the real card, not an under-measured feasibility value."""

    def test_prefers_live_system_stats_over_stale_feasibility(self):
        # 30.3 GB card via /system_stats; feasibility under-measured (free*0.85 = 21.7 GiB).
        ss = {"devices": [{"vram_total": int(30.3 * 1024**3)}]}
        feas = {"hardware": {"usable_budget_bytes": int(21.7 * 1024**3)}}
        budget = infer_usable_budget_bytes(ss, feas)
        # ~25.8 GiB from system_stats, NOT the stale 21.7
        self.assertAlmostEqual(budget / 1024**3, 30.3 * 0.85, places=1)

    def test_falls_back_to_feasibility_when_no_live_total(self):
        budget = infer_usable_budget_bytes({"devices": []}, {"hardware": {"usable_budget_bytes": 123}})
        self.assertEqual(budget, 123)

    def test_none_when_neither_available(self):
        self.assertIsNone(infer_usable_budget_bytes({}, None))


class TestClassifyReducedValidation(unittest.TestCase):
    """13-003: never assert a VRAM fit that wasn't measured (preserve the tri-state)."""

    def test_A_success_output_present_no_telemetry(self):
        # Ran clean + wrote output, but telemetry gave no ratio (e.g. error: 39).
        # -> validated must stay None (NOT True); run succeeded; telemetry unavailable.
        result = classify_reduced_validation(
            rv_status="history_available",
            status_str="success",
            ratio=None,
            signature=None,
            output_written=True,
        )
        self.assertIsNone(result["validated"])
        self.assertIs(result["reduced_run_succeeded"], True)
        self.assertIs(result["telemetry_available"], False)
        self.assertIn("deferred to Step 12", result["note"])

    def test_B_history_timeout_is_false(self):
        result = classify_reduced_validation(
            rv_status="history_timeout",
            status_str=None,
            ratio=None,
            signature=None,
            output_written=False,
        )
        self.assertIs(result["validated"], False)
        self.assertEqual(result["reduced_capacity_tier"], "insufficient")

    def test_B2_capacity_signature_is_false(self):
        # A capacity signature (even with a measured sub-budget ratio) is a hard fail.
        result = classify_reduced_validation(
            rv_status="history_available",
            status_str="error",
            ratio=0.55,
            signature="out_of_device_memory",
            output_written=False,
        )
        self.assertIs(result["validated"], False)
        self.assertEqual(result["reduced_capacity_tier"], "insufficient")

    def test_C_over_budget_measured_is_false(self):
        # Regression: success + output + MEASURED ratio 1.03 -> over budget, not a fit.
        result = classify_reduced_validation(
            rv_status="history_available",
            status_str="success",
            ratio=1.03,
            signature=None,
            output_written=True,
        )
        self.assertIs(result["validated"], False)
        self.assertEqual(result["reduced_capacity_tier"], "reduced")

    def test_D_clean_measured_fit_is_true(self):
        # success + output + measured ratio 0.70 -> a real, measured clean fit.
        result = classify_reduced_validation(
            rv_status="history_available",
            status_str="success",
            ratio=0.70,
            signature=None,
            output_written=True,
        )
        self.assertIs(result["validated"], True)
        self.assertEqual(result["reduced_capacity_tier"], "ok")
        self.assertIs(result["telemetry_available"], True)
        self.assertIs(result["reduced_run_succeeded"], True)

    def test_success_status_but_no_output_is_not_a_fit(self):
        # "success" status with NO output artifact must not be validated True even with
        # a good ratio: the run is not proven to have produced anything.
        result = classify_reduced_validation(
            rv_status="history_available",
            status_str="success",
            ratio=0.70,
            signature=None,
            output_written=False,
        )
        self.assertIsNot(result["validated"], True)
        self.assertIs(result["reduced_run_succeeded"], False)

    def test_ratio_none_but_run_failed_is_false(self):
        # No ratio AND no verified success (status error, no output) -> honest failure.
        result = classify_reduced_validation(
            rv_status="history_available",
            status_str="error",
            ratio=None,
            signature=None,
            output_written=False,
        )
        self.assertIs(result["validated"], False)
        self.assertIs(result["reduced_run_succeeded"], False)


class TestMergeReducedValidationIntoAggregate(unittest.TestCase):
    """13-009: a reduced-validation pass must not clobber capacity-probe evidence."""

    def _probe_summary(self):
        return {
            "capacity_classification": {
                "capacity_tier": "insufficient",
                "full_size_supported": False,
                "recommend_reduced_tier": True,
                "recommended_reduced_setting": {"resolution": "480x832", "frames": 49},
            },
            "step12_context": {
                "capacity_tier": "insufficient",
                "full_size_supported": False,
                "recommend_reduced_tier": True,
                "recommended_reduced_setting": {"resolution": "480x832", "frames": 49},
                "reduced_validation": None,
            },
        }

    def _reduced_validation_run_view(self):
        # What a standalone reduced-validation run builds for ITS own aggregate: full-size
        # capacity unknown (it never exercised full size) + None recommendation.
        return {
            "capacity_classification": {
                "capacity_tier": "unknown",
                "full_size_supported": False,
                "recommend_reduced_tier": False,
                "recommended_reduced_setting": None,
            },
            "step12_context": {
                "capacity_tier": "unknown",
                "full_size_supported": False,
                "recommend_reduced_tier": False,
                "recommended_reduced_setting": None,
                "reduced_validation": None,
            },
            "completion_decision": {
                "capacity": {"capacity_tier": "unknown"},
                "capacity_tier": "unknown",
                "full_size_supported": False,
            },
        }

    def test_merge_preserves_probe_capacity_and_attaches_verdict(self):
        summary = self._reduced_validation_run_view()
        reduced_validation = {
            "validated": True,
            "reduced_capacity_tier": "ok",
            "reduced_run_succeeded": True,
            "telemetry_available": True,
        }
        merged = merge_reduced_validation_into_aggregate(
            summary, self._probe_summary(), reduced_validation
        )

        # Capacity-probe evidence survives (NOT clobbered to unknown/None).
        self.assertEqual(merged["capacity_classification"]["capacity_tier"], "insufficient")
        self.assertIsNotNone(merged["step12_context"]["recommended_reduced_setting"])
        self.assertEqual(
            merged["step12_context"]["recommended_reduced_setting"]["frames"], 49
        )
        # completion_decision capacity is realigned to the carried-forward tier.
        self.assertEqual(merged["completion_decision"]["capacity_tier"], "insufficient")
        # THIS run's reduced verdict is attached.
        self.assertIs(merged["step12_context"]["reduced_validation"]["validated"], True)
        self.assertTrue(merged["step12_context"]["reduced_validation_carried_forward"])
        self.assertEqual(
            merged["capacity_classification"]["carried_forward_from"],
            "08-capacity-probe-run-summary.json",
        )

    def test_merge_degrades_gracefully_without_probe_summary(self):
        summary = self._reduced_validation_run_view()
        reduced_validation = {"validated": None}
        merged = merge_reduced_validation_into_aggregate(summary, None, reduced_validation)
        # Does not crash; still attaches the verdict and records a note.
        self.assertIs(merged["step12_context"]["reduced_validation"], reduced_validation)
        self.assertTrue(any("no capacity-probe" in n for n in merged.get("notes", [])))


class TestSummarizeHistoryParserGuard(unittest.TestCase):
    """13-009 parser guard: cached nodes come from status.messages, not a top-level key."""

    def test_cached_from_messages_decoy_ignored(self):
        history = {
            "outputs": {},
            # Decoy: a bogus top-level key the parser must ignore.
            "execution_cached": {"nodes": ["999"]},
            "status": {
                "status_str": "success",
                "completed": True,
                "messages": [
                    ["execution_cached", {"nodes": ["3"]}],
                ],
            },
        }
        summary = summarize_history(history, Path("/nonexistent-comfy-root"))
        self.assertEqual(summary["cached_nodes"], ["3"])
        self.assertNotIn("999", summary["cached_nodes"])


if __name__ == "__main__":
    unittest.main()
