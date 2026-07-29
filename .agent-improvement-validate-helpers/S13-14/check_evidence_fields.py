#!/usr/bin/env python3
"""Confirm the S13-14 addition does not weaken the tuning report's required evidence fields.

Checks:
1. The edited skill file still references every required evidence field.
2. The source-task 09-tuning.md artifact (Zimage v2 / LongCat precedent) still
   contains all required evidence sections, proving the no_runtime_change_selected
   outcome there documented the full evidence set the new skill text demands.
"""
import re
import sys

SKILL = "prompts/migration-workflow-v2/skills/09-performance-tuning-skill.md"
ARTIFACT = (
    "/home/intel/tianfeng/comfy/ComfyUI/agent-demo/workspaces/"
    "ca76e727-68f6-45da-8c8b-bb46c70161bc/artifacts/09-tuning.md"
)

REQUIRED_FIELDS = [
    "baseline",
    "candidate matrix",
    "measurements",
    "rejected configs",
    "telemetry validity",
    "remaining bottleneck",
    "next-step boundary",
]

# Synonyms/section headers used in the artifact (case-insensitive substring).
ARTIFACT_MARKERS = {
    "baseline": ["baseline"],
    "candidate matrix": ["candidate matrix"],
    "measurements": ["measurements"],
    "rejected configs": ["rejected config"],
    "telemetry validity": ["telemetry validity"],
    "remaining bottleneck": ["remaining bottleneck"],
    "next-step boundary": ["next-step coverage boundary", "next-step boundary"],
}

errors = []

with open(SKILL, encoding="utf-8") as f:
    skill_text = f.read().lower()

# The new addition must mention the outcome and the source-code-change condition.
for needle in [
    "no_runtime_change_selected",
    "source-code change",
    "zimage v2",
]:
    if needle not in skill_text:
        errors.append(f"skill missing required phrase: {needle!r}")

# Skill should still list each required evidence field somewhere (flexible markers,
# since the skill uses its own terminology e.g. "rejected", "Step 10 boundary").
SKILL_MARKERS = {
    "baseline": ["baseline"],
    "candidate matrix": ["candidate matrix", "candidate"],
    "measurements": ["measurement", "wall time", "metric"],
    "rejected configs": ["rejected"],
    "telemetry validity": ["telemetry validity", "telemetry"],
    "remaining bottleneck": ["remaining bottleneck", "remaining_bottleneck"],
    "next-step boundary": ["next-step boundary", "step 10 boundary", "step 10"],
}
for field, markers in SKILL_MARKERS.items():
    if not any(m in skill_text for m in markers):
        errors.append(f"skill missing required evidence field: {field!r}")

with open(ARTIFACT, encoding="utf-8") as f:
    artifact_text = f.read().lower()

for field, markers in ARTIFACT_MARKERS.items():
    if not any(m in artifact_text for m in markers):
        errors.append(f"artifact 09-tuning.md missing evidence section: {field!r}")

if errors:
    print("FAIL: evidence-field check found problems:")
    for e in errors:
        print("  - " + e)
    sys.exit(1)

print("PASS: skill retains all required evidence fields and references the Zimage v2 precedent;")
print("      artifact 09-tuning.md documents the full evidence set for no_runtime_change_selected.")
