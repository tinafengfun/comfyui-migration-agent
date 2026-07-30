#!/usr/bin/env python3
"""Regression test for S13-02: control_after_generate widget re-alignment.

Validates the repair added to step06_prompt_validation.repair_seed_control_widget_alignment:
  1. A synthetic WanVideoSamplerv2 node with widgets_values
     [cfg, seed, "randomize", force_offload, add_noise_to_samples] and a
     misaligned converted prompt is repaired so force_offload / add_noise_to_samples
     map to their correct values.
  2. The real node 51 from the source task's workflow is loaded, a misaligned
     prompt is built, repaired, and asserted correct -- and the source workflow
     dict is asserted deep-equal to a fresh load (the repair never mutates it).
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parents[2] / "prompts" / "migration-workflow-v2" / "tools"
sys.path.insert(0, str(TOOLS_DIR))

from step06_prompt_validation import (  # noqa: E402
    repair_seed_control_widget_alignment,
    convert_workflow,
)

SOURCE_WORKFLOW = Path(
    "/home/intel/tianfeng/comfy/ComfyUI/agent-demo/workspaces/"
    "ca76e727-68f6-45da-8c8b-bb46c70161bc/source/"
    "LongCat_Video_Avatar_Lip-Synced_Generator_workflow.json"
)


def _widget_input(name, widget_name=None, link=None, input_type=None):
    entry = {"name": name, "widget": {"name": widget_name or name}, "link": link}
    if input_type is not None:
        entry["type"] = input_type
    return entry


def _link_input(name, link, input_type):
    return {"name": name, "link": link, "type": input_type}


def test_synthetic_node():
    workflow = {
        "nodes": [
            {
                "id": 51,
                "type": "WanVideoSamplerv2",
                "widgets_values": [1, 415693654810179, "randomize", True, False],
                "inputs": [
                    _link_input("model", 57, "WANVIDEOMODEL"),
                    _link_input("image_embeds", 58, "WANVIDIMAGE_EMBEDS"),
                    _link_input("scheduler", 61, "WANVIDEOSCHEDULER"),
                    _link_input("text_embeds", 56, "WANVIDEOTEXTEMBEDS"),
                    _link_input("samples", 59, "LATENT"),
                    {"name": "extra_args", "link": None, "type": "WANVIDSAMPLEREXTRAARGS"},
                    _widget_input("cfg", input_type="FLOAT"),
                    _widget_input("seed", input_type="INT"),
                    _widget_input("force_offload", input_type="BOOLEAN"),
                    _widget_input("add_noise_to_samples", input_type="BOOLEAN"),
                ],
            }
        ]
    }
    # Misaligned prompt exactly as the buggy converter produces it.
    prompt = {
        "51": {
            "class_type": "WanVideoSamplerv2",
            "inputs": {
                "model": ["8", 0],
                "image_embeds": ["6", 0],
                "scheduler": ["52", 0],
                "text_embeds": ["15", 0],
                "samples": ["6", 1],
                "cfg": 1,
                "seed": 415693654810179,
                "force_offload": "randomize",  # wrong (got the control_after_generate slot)
                "add_noise_to_samples": True,  # wrong (shifted by one)
            },
        }
    }
    changes = repair_seed_control_widget_alignment(workflow, prompt)
    inputs = prompt["51"]["inputs"]
    assert inputs["force_offload"] is True, f"force_offload should be True, got {inputs['force_offload']!r}"
    assert inputs["add_noise_to_samples"] is False, (
        f"add_noise_to_samples should be False, got {inputs['add_noise_to_samples']!r}"
    )
    assert inputs["seed"] == 415693654810179, f"seed should be unchanged, got {inputs['seed']!r}"
    assert inputs["cfg"] == 1, f"cfg should be unchanged, got {inputs['cfg']!r}"
    assert any(c["input_name"] == "force_offload" for c in changes), "expected a force_offload change record"
    assert any(c["input_name"] == "add_noise_to_samples" for c in changes), (
        "expected an add_noise_to_samples change record"
    )
    print("synthetic_node: PASS (force_offload=True, add_noise_to_samples=False)")


def test_real_node_51_and_source_unchanged():
    workflow = json.loads(SOURCE_WORKFLOW.read_text(encoding="utf-8"))
    workflow_before = copy.deepcopy(workflow)
    node51 = next(n for n in workflow["nodes"] if n.get("id") == 51)
    widgets = node51["widgets_values"]
    # Sanity: the GUI really did insert the control_after_generate selector
    # right after the seed value (seed is widgets_values[1]).
    assert widgets[1] == 415693654810179, f"expected seed at slot 1, got {widgets[1]!r}"
    assert widgets[2] == "randomize", f"expected control_after_generate selector at slot 2, got {widgets[2]!r}"

    # Build a misaligned prompt exactly as the buggy converter emits node 51.
    prompt = {
        "51": {
            "class_type": "WanVideoSamplerv2",
            "inputs": {
                "model": ["8", 0],
                "image_embeds": ["6", 0],
                "scheduler": ["52", 0],
                "text_embeds": ["15", 0],
                "samples": ["6", 1],
                "cfg": widgets[0],
                "seed": widgets[1],
                "force_offload": widgets[2],  # "randomize" -- the bug
                "add_noise_to_samples": widgets[3],  # True -- shifted
            },
        }
    }
    changes = repair_seed_control_widget_alignment(workflow, prompt)
    inputs = prompt["51"]["inputs"]
    assert inputs["force_offload"] is True, f"force_offload should be True, got {inputs['force_offload']!r}"
    assert inputs["add_noise_to_samples"] is False, (
        f"add_noise_to_samples should be False, got {inputs['add_noise_to_samples']!r}"
    )
    # The repair must never mutate the source workflow.
    assert workflow == workflow_before, "repair mutated the source workflow"
    assert workflow == json.loads(SOURCE_WORKFLOW.read_text(encoding="utf-8")), (
        "source workflow file content changed on disk"
    )
    print("real_node_51_and_source_unchanged: PASS (force_offload=True, add_noise_to_samples=False, source untouched)")


def test_node_without_selector_is_not_touched():
    # A node whose seed is NOT followed by a control_after_generate selector
    # must be left unchanged (idempotent / no false positives).
    workflow = {
        "nodes": [
            {
                "id": 7,
                "type": "WanVideoSamplerv2",
                "widgets_values": [1, 123, True, False],
                "inputs": [
                    _widget_input("cfg", input_type="FLOAT"),
                    _widget_input("seed", input_type="INT"),
                    _widget_input("force_offload", input_type="BOOLEAN"),
                    _widget_input("add_noise_to_samples", input_type="BOOLEAN"),
                ],
            }
        ]
    }
    prompt = {
        "7": {
            "class_type": "WanVideoSamplerv2",
            "inputs": {"cfg": 1, "seed": 123, "force_offload": True, "add_noise_to_samples": False},
        }
    }
    changes = repair_seed_control_widget_alignment(workflow, prompt)
    assert changes == [], f"expected no changes for aligned node, got {changes}"
    assert prompt["7"]["inputs"]["force_offload"] is True
    assert prompt["7"]["inputs"]["add_noise_to_samples"] is False
    print("node_without_selector: PASS (no false-positive edits)")


def test_end_to_end_real_converter():
    """Run the real ComfyUI converter on the source workflow, then the repair,
    and assert node 51's widget inputs are correctly aligned."""
    comfy_root = Path("/home/intel/tianfeng/comfy/ComfyUI")
    workflow = json.loads(SOURCE_WORKFLOW.read_text(encoding="utf-8"))
    workflow_before = copy.deepcopy(workflow)
    prompt = convert_workflow(comfy_root, workflow)
    # Sanity: confirm the converter really produced the misaligned (buggy) values
    # before the repair, so this test is meaningful.
    assert prompt["51"]["inputs"]["force_offload"] == "randomize", (
        "expected buggy converter to set force_offload='randomize' before repair"
    )
    assert prompt["51"]["inputs"]["add_noise_to_samples"] is True, (
        "expected buggy converter to set add_noise_to_samples=True before repair"
    )
    changes = repair_seed_control_widget_alignment(workflow, prompt)
    inputs = prompt["51"]["inputs"]
    assert inputs["force_offload"] is True, f"force_offload should be True, got {inputs['force_offload']!r}"
    assert inputs["add_noise_to_samples"] is False, (
        f"add_noise_to_samples should be False, got {inputs['add_noise_to_samples']!r}"
    )
    assert inputs["seed"] == 415693654810179
    assert inputs["cfg"] == 1
    assert workflow == workflow_before, "repair mutated the source workflow"
    print("end_to_end_real_converter: PASS (converter+repair -> force_offload=True, add_noise_to_samples=False)")


if __name__ == "__main__":
    test_synthetic_node()
    test_real_node_51_and_source_unchanged()
    test_node_without_selector_is_not_touched()
    test_end_to_end_real_converter()
    print("\nALL S13-02 REGRESSION TESTS PASSED")
