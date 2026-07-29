#!/usr/bin/env python3
"""Validate that the restricted-runtime-policy delivery pattern checklist
produces the same claim boundary as the actual Step 11 artifacts for task
ca76e727-68f6-45da-8c8b-bb46c70161bc.

Read-only checks against the source task's artifact dir. Exits non-zero on
any mismatch.
"""
import json
import os
import sys

ART = "/home/intel/tianfeng/comfy/ComfyUI/agent-demo/workspaces/ca76e727-68f6-45da-8c8b-bb46c70161bc/artifacts"
SUMMARY = os.path.join(ART, "11-delivery-summary.json")
DELIVERY = os.path.join(ART, "11-delivery")
WORKFLOWS = os.path.join(DELIVERY, "workflows")

errors = []


def check(cond, msg):
    if not cond:
        errors.append(msg)


with open(SUMMARY) as f:
    s = json.load(f)

cd = s["completion_decision"]

# (1) customer_ready=false
check(cd.get("customer_ready") is False,
      "(1) customer_ready should be False, got %r" % cd.get("customer_ready"))
check(s["support_matrix"].get("customer_ready") is False,
      "(1) support_matrix.customer_ready should be False")

# (2) bundle only boundary-matching evidence; claim_boundary restricted-smoke
check(cd.get("claim_boundary") == "restricted-runtime-policy-smoke-level",
      "(2) claim_boundary should be restricted-runtime-policy-smoke-level, got %r"
      % cd.get("claim_boundary"))
# no full-size videos in outputs
out_dir = os.path.join(DELIVERY, "outputs")
mp4s = [n for n in os.listdir(out_dir) if n.endswith(".mp4")]
fullsize = [n for n in mp4s if "fullsize" in n.lower() or "full-size" in n.lower()]
check(not fullsize, "(2) no full-size outputs expected in bundle, found %r" % fullsize)
# all smoke videos present
smoke = [n for n in mp4s if n.startswith("smoke-")]
check(len(smoke) == 2, "(2) expected 2 smoke mp4s, found %r" % smoke)

# (3) source and runtime-policy artifacts as separate files
check(os.path.isfile(os.path.join(WORKFLOWS, "source-workflow.json")),
      "(3) source-workflow.json missing")
check(os.path.isfile(os.path.join(WORKFLOWS, "runtime-policy-prompt.json")),
      "(3) runtime-policy-prompt.json missing")
check(os.path.isfile(os.path.join(WORKFLOWS, "mitigation-blockswap-prompt.json")),
      "(3) mitigation-blockswap-prompt.json missing")
# no gui workflow produced in Step 11
check(not os.path.isfile(os.path.join(WORKFLOWS, "runtime-policy-gui-workflow.json")),
      "(6) runtime-policy-gui-workflow.json should NOT exist in Step 11 bundle")

# (4) route GUI/manual acceptance to Step 12
ac = s["acceptance_steps"]
check(ac.get("gui_manual_met") is False, "(4) gui_manual_met should be False")
check(ac.get("step12_required") is True, "(4) step12_required should be True")
check("Step 12" in cd.get("next_step_recommendation", ""),
      "(4) next_step_recommendation should mention Step 12")

# (5) step12_context completeness
ctx = s.get("step12_context", {})
required_keys = [
    "delivery_directory",
    "source_workflow_copy",
    "runtime_policy_prompt",
    "manual_test_plan",
    "api_url",
    "claim_boundary_warning",
]
for k in required_keys:
    check(k in ctx, "(5) step12_context missing key %r" % k)
check("restricted runtime-policy" in ctx.get("claim_boundary_warning", "").lower()
      or "restricted-runtime-policy" in ctx.get("claim_boundary_warning", "").lower(),
      "(5) claim_boundary_warning should mention restricted runtime-policy")
check("runtime-policy-gui-workflow" in ctx.get("claim_boundary_warning", ""),
      "(5) claim_boundary_warning should mention runtime-policy-gui-workflow.json")

# (6) runtime-policy-gui-workflow.json produced in Step 12, not 11
check("gui_workflow_note" in ctx,
      "(6) step12_context should include gui_workflow_note")
check("Step 12" in ctx.get("gui_workflow_note", ""),
      "(6) gui_workflow_note should reference Step 12")

if errors:
    print("VALIDATION FAILED:")
    for e in errors:
        print(" - " + e)
    sys.exit(1)
print("VALIDATION PASSED: restricted-runtime-policy delivery pattern checklist "
      "reproduces the same restricted-runtime-policy-smoke-level boundary.")
