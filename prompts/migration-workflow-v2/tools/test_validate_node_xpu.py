#!/usr/bin/env python3
"""Unit tests for validate_node_xpu (the per-node XPU harness verdict logic).

Run: python3 -m unittest test_validate_node_xpu  (from the tools/ dir)
Stdlib-only; no ComfyUI venv or network needed.
"""
import unittest

import validate_node_xpu as v


class JudgeVerdict(unittest.TestCase):
    def base(self, **over):
        args = dict(
            completed=True,
            status_success=True,
            has_outputs=True,
            capacity_signature=None,
            peak_gpu_util=80.0,
            expect_execution="xpu",
            threshold=15.0,
        )
        args.update(over)
        return v.judge_verdict(**args)

    def test_success_on_xpu_with_high_util(self):
        r = self.base()
        self.assertTrue(r["passed"])
        self.assertEqual(r["historyResult"], "success")
        self.assertFalse(r["cpuFallbackSuspected"])

    def test_cpu_fallback_on_xpu_low_util_fails(self):
        # Expected XPU but GPU stayed near-idle → silent CPU fallback → FAIL.
        r = self.base(peak_gpu_util=2.0)
        self.assertFalse(r["passed"])
        self.assertEqual(r["historyResult"], "cpu_fallback_suspected")
        self.assertTrue(r["cpuFallbackSuspected"])

    def test_cpu_expected_low_util_passes(self):
        # A node that legitimately runs on CPU (execution=cpu) is not penalized.
        r = self.base(expect_execution="cpu", peak_gpu_util=1.0)
        self.assertTrue(r["passed"])
        self.assertEqual(r["historyResult"], "success")
        self.assertFalse(r["cpuFallbackSuspected"])

    def test_failed_runtime(self):
        r = self.base(status_success=False)
        self.assertFalse(r["passed"])
        self.assertEqual(r["historyResult"], "failed_runtime")

    def test_no_outputs_is_failed_runtime(self):
        r = self.base(has_outputs=False)
        self.assertFalse(r["passed"])
        self.assertEqual(r["historyResult"], "failed_runtime")

    def test_capacity_signature_takes_priority(self):
        # Even with a "success"-looking history, a capacity signature fails it.
        r = self.base(capacity_signature="out_of_device_memory", peak_gpu_util=90.0)
        self.assertFalse(r["passed"])
        self.assertEqual(r["historyResult"], "capacity_suspected")
        self.assertTrue(r["capacitySuspected"])

    def test_missing_telemetry_does_not_flag_cpu_fallback(self):
        # util=None (xpu-smi unavailable) → cannot prove CPU fallback → still passes if it ran.
        r = self.base(peak_gpu_util=None)
        self.assertTrue(r["passed"])
        self.assertFalse(r["cpuFallbackSuspected"])


class TargetResolution(unittest.TestCase):
    GRAPH = {
        "10": {"class_type": "KSampler", "inputs": {"steps": 20}},
        "34": {"class_type": "BerniniConditioning", "inputs": {"ref_max_size": 1280}},
        "90": {"class_type": "VHS_LoadVideo", "inputs": {}},
        "34b": {"class_type": "BerniniConditioning", "inputs": {}},
    }

    def test_find_by_id_and_type_with_dedup(self):
        targets = v.find_target_node_ids(self.GRAPH, ["34"], ["BerniniConditioning"])
        ids = [t[0] for t in targets]
        # explicit id 34 first, then the OTHER BerniniConditioning (34b), 34 not duplicated
        self.assertEqual(ids[0], "34")
        self.assertIn("34b", ids)
        self.assertEqual(len(ids), len(set(ids)))

    def test_reduce_steps_sets_one_leaves_others(self):
        reduced = v.reduce_steps(self.GRAPH)
        self.assertEqual(reduced["10"]["inputs"]["steps"], 1)
        self.assertEqual(reduced["34"]["inputs"]["ref_max_size"], 1280)  # untouched
        # original graph not mutated
        self.assertEqual(self.GRAPH["10"]["inputs"]["steps"], 20)


class GraphUnwrap(unittest.TestCase):
    def test_unwraps_prompt_envelope(self):
        self.assertEqual(v.graph_of({"prompt": {"1": {}}}), {"1": {}})
        self.assertEqual(v.graph_of({"1": {}}), {"1": {}})


class WriteBackEmission(unittest.TestCase):
    def _args(self, **over):
        import argparse

        base = dict(
            node_key="acme__foo", repository="https://github.com/acme/Foo",
            package_name="Foo", nfs_path="/nfs_share/custom_nodes/Foo", commit=None,
            xpu_support="patched", package_execution="xpu",
        )
        base.update(over)
        return argparse.Namespace(**base)

    def test_build_entries_carries_package_meta_and_evidence(self):
        verdicts = [{"nodeType": "FooNode", "passed": True, "historyResult": "success", "xpuUtilizationPct": 80.0, "passedAt": "2026-08-18T01:00:00Z"}]
        entries = v.build_writeback_entries(self._args(), verdicts)
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["nodeKey"], "acme__foo")
        self.assertEqual(e["repository"], "https://github.com/acme/Foo")
        self.assertEqual(e["xpuSupport"], "patched")
        self.assertEqual(e["evidence"]["nodeType"], "FooNode")
        self.assertTrue(e["evidence"]["passed"])

    def test_merge_appends_and_survives_corrupt_prior(self):
        import json
        import tempfile
        from pathlib import Path

        verdicts = [{"nodeType": "FooNode", "passed": True, "historyResult": "success", "xpuUtilizationPct": 80.0, "passedAt": "2026-08-18T01:00:00Z"}]
        entries = v.build_writeback_entries(self._args(), verdicts)
        d = Path(tempfile.mkdtemp())
        p = d / "catalog-writeback.json"
        v.merge_writeback(p, entries)
        v.merge_writeback(p, entries)  # append, not replace
        doc = json.loads(p.read_text())
        self.assertEqual(len(doc["nodes"]), 2)
        self.assertEqual(doc["step"], "05")
        # a corrupt prior file must not lose the new run
        p.write_text("{ not json")
        v.merge_writeback(p, entries)
        self.assertEqual(len(json.loads(p.read_text())["nodes"]), 1)


if __name__ == "__main__":
    unittest.main()
