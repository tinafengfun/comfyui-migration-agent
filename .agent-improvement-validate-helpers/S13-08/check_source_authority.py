#!/usr/bin/env python3
"""Validation S13-08 #2: Step 04 still works when agent and runtime mirrors match.

Checks the Step 04 skill's Source authority section:
  - states the runtime checkout is authoritative,
  - states the agent-local mirror is a convenience only,
  - records both hashes when they differ,
  - explicitly handles the matching case (no extra reconciliation needed).

Also ties to the real task artifacts: confirms the real 04-source-audit.md recorded
both commit hashes (f0b247ab agent mirror, 088128b2 runtime) -- i.e. the new guidance
is consistent with what the source run actually did.
Exits non-zero on any failure.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "prompts/migration-workflow-v2/skills/04-source-audit-skill.md"
ARTIFACT_DIR = Path(
    "/home/intel/tianfeng/comfy/ComfyUI/agent-demo/workspaces/"
    "ca76e727-68f6-45da-8c8b-bb46c70161bc/artifacts"
)
AUDIT_MD = ARTIFACT_DIR / "04-source-audit.md"

failures = []

skill_text = SKILL.read_text()

if "runtime docker node's custom-node checkout is the authoritative source" not in skill_text:
    failures.append("skill: runtime checkout authority not stated")
if "convenience only" not in skill_text:
    failures.append("skill: agent-local mirror as convenience only not stated")
if "Record both hashes" not in skill_text:
    failures.append("skill: 'record both hashes' guidance missing")
# Matching-case handling: Step 04 must still work when mirrors match.
if "mirrors match" not in skill_text or "no extra reconciliation" not in skill_text:
    failures.append("skill: matching-mirror case (no extra reconciliation) not handled")

# Real artifact cross-check: the source run recorded both hashes.
audit_text = AUDIT_MD.read_text()
if "f0b247ab" not in audit_text or "088128b2" not in audit_text:
    failures.append("real 04-source-audit.md does not record both commit hashes (f0b247ab / 088128b2)")

if failures:
    print("FAIL:")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("OK: Step 04 handles matching mirrors and the real audit recorded both hashes")
