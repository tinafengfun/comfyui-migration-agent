#!/usr/bin/env python3
"""Validate S13-13 note in 01-asset-and-custom-node-resolution-skill.md.

Checks that the added note is non-normative clarification:
  - explicitly labels itself as clarification / non-rule-changing,
  - does not introduce new MUST / SHALL / REQUIRED / MUST NOT imperatives
    beyond the pre-existing ones in the file (i.e. the note block itself
    contains none of these normative keywords),
  - preserves the original step-7 acquisition wording verbatim.
"""
import re
import sys

PATH = "prompts/migration-workflow-v2/skills/01-asset-and-custom-node-resolution-skill.md"

with open(PATH, encoding="utf-8") as f:
    text = f.read()

errors = []

# Original step 7 wording must still be present (acquisition rule unchanged).
original_step7 = (
    "If the remaining hard stop is source-known but not staged, run a bounded "
    "acquisition pass before asking for human input: copy/download exact model "
    "files into an isolated workflow cache that mirrors both ComfyUI's model "
    "layout and the custom node's expected cache layout, or record why "
    "policy/access/exactness blocks the item."
)
if original_step7 not in text:
    errors.append("original step-7 acquisition wording is no longer present verbatim")

# Locate the added note block.
m = re.search(
    r"Note \(clarification, does not change the acquisition rules above\):.*?"
    r"Staging into the right subfolder up front avoids that repair\.",
    text, re.S,
)
if not m:
    errors.append("clarifying note block not found")
else:
    note = m.group(0)
    if "does not change the acquisition rules above" not in note:
        errors.append("note does not self-label as non-rule-changing")
    # Normative keywords must not appear inside the note block.
    normative = re.findall(r"\b(MUST NOT|MUST|SHALL|SHALL NOT|REQUIRED)\b", note)
    if normative:
        errors.append(
            "note contains normative keywords (should be non-normative): "
            + ", ".join(sorted(set(normative)))
        )

if errors:
    print("FAIL:")
    for e in errors:
        print(" - " + e)
    sys.exit(1)
print("OK: note is non-normative clarification and acquisition rule preserved")
