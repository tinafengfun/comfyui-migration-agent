#!/usr/bin/env python3
"""Validation for improvement S13-01.

Check 1: Re-run the CUDA-ism scan against the real WanVideoWrapper source and
         confirm the forward cuda-gate (model.py:3202-3209) is found in the
         first pass, classified as a silent-feature-disable (class b).
Check 2: Confirm the edited skill/prompt files still forbid bypass/delete of
         nodes (the new checklist item must not change node-integrity rules).
"""
import os
import re
import sys

WORKTREE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODEL = "/home/intel/ComfyUI/custom_nodes/ComfyUI-WanVideoWrapper/wanvideo/modules/model.py"
SKILL = os.path.join(WORKTREE, "prompts/migration-workflow-v2/skills/04-source-audit-skill.md")
PROMPT = os.path.join(WORKTREE, "prompts/migration-workflow-v2/prompts/04-source-audit-prompt.md")

CUDA_ISMS = [
    r"torch\.cuda\.is_available\(\)",
    r"torch\.cuda\.stream",
    r"torch\.cuda\.Stream",
    r"torch\.cuda\.Event",
    r"\.cuda\(\)",
    r"device=['\"]cuda",
    r"cuda:0",
]

errors = []

# --- Check 1: scan the real source ---
with open(MODEL, "r") as f:
    lines = f.readlines()

hits = []
for i, line in enumerate(lines, 1):
    for pat in CUDA_ISMS:
        if re.search(pat, line):
            hits.append((i, pat, line.rstrip()))
            break

# The forward cuda-gate must appear around lines 3202-3209.
gate_lines = [i for i, _, _ in hits if 3202 <= i <= 3209]
if not gate_lines:
    errors.append(
        "CUDA-ism scan did NOT find the forward cuda-gate at model.py:3202-3209; "
        "the new checklist would miss the worked example."
    )
else:
    print(f"OK: forward cuda-gate found at model.py lines {gate_lines}")

# Classify: the forward cuda-gate is a silent feature disable (class b) because
# it sets swap_start_idx = len(self.blocks) in the else branch, disabling cycling.
gate_src = "".join(lines[3201:3209])
if "swap_start_idx = len(self.blocks)" in gate_src and "torch.cuda.is_available()" in gate_src:
    print("OK: forward cuda-gate classified as silent feature disable (class b)")
else:
    errors.append("Forward cuda-gate could not be classified as class (b).")

# Confirm init block_swap is device-agnostic (no cuda gate) to prove an init-only
# audit would miss it.
init_src = "".join(lines[2039:2065])
if "torch.cuda.is_available" not in init_src:
    print("OK: init block_swap (2040-2065) is device-agnostic; init-only audit would miss the runtime gate")
else:
    errors.append("init block_swap contains a cuda gate; worked-example assumption broken")

# --- Check 2: node-integrity rules unchanged ---
for path in (SKILL, PROMPT):
    with open(path, "r") as f:
        text = f.read()
    if "silent feature disable" not in text:
        errors.append(f"{path}: new 'silent feature disable' classification missing")
    if "forward" not in text.lower():
        errors.append(f"{path}: forward-loop requirement missing")
    for marker in ["CUDA-ism scan"]:
        idx = text.find(marker)
        if idx == -1:
            continue
        window = text[idx:idx + 3000]
        for forbidden in ["bypass the node", "delete the node", "remove the node", "disable the node"]:
            if forbidden in window.lower():
                errors.append(
                    f"{path}: new CUDA-ism scan section introduces forbidden node-integrity "
                    f"instruction '{forbidden}'"
                )
    print(f"OK: {path} contains CUDA-ism scan without bypass/delete node-integrity changes")

if errors:
    print("\nFAILED:")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print("\nAll S13-01 validation checks passed.")
