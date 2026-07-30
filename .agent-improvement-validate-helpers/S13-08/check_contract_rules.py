#!/usr/bin/env python3
"""Validation S13-08 #1: the new note does not change the no-bypass / no-edit-source rules.

Checks:
  1. Common Migration Contract items 1 and 2 still contain the no-bypass and
     no-edit-source clauses verbatim.
  2. The newly added note (in agent.md item 14 and in the Step 04 skill) explicitly
     states it does not weaken those rules.
Exits non-zero on any failure.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENT = ROOT / "prompts/migration-workflow-v2/agent.md"
SKILL = ROOT / "prompts/migration-workflow-v2/skills/04-source-audit-skill.md"

failures = []

agent_text = AGENT.read_text()
skill_text = SKILL.read_text()

# Item 1: no-bypass rule.
if "never bypass, delete, disable, mute, collapse, rewire, or semantically replace nodes" not in agent_text:
    failures.append("agent.md item 1 no-bypass clause missing/changed")
# Item 2: no-edit-source rule.
if "Do not edit the source workflow in place" not in agent_text:
    failures.append("agent.md item 2 no-edit-source clause missing/changed")

# The new note must explicitly disclaim weakening those rules.
if "does not change the no-bypass/no-edit-source rules" not in agent_text:
    failures.append("agent.md item 14 note missing disclaimer about no-bypass/no-edit-source rules")
if "does not weaken the no-bypass / no-edit-source rules" not in skill_text:
    failures.append("Step 04 skill Source authority note missing disclaimer")

if failures:
    print("FAIL:")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("OK: no-bypass/no-edit-source rules intact and disclaimed by the new note")
