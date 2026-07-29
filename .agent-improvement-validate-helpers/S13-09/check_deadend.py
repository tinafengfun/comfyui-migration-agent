#!/usr/bin/env python3
"""Validate the S13-09 dead-end node detection algorithm against the real task artifacts.

Implements the trace described in 03-workflow-inventory-skill.md:
  1. output roots = API-prompt nodes whose class has OUTPUT_NODE = True in object_info
     (what execution.validate_prompt uses).
  2. walk upstream over inputs links ([upstream_id, out_idx]) from each output root.
  3. live set = union of upstream trees; dead-end = API-prompt nodes not in live set.
Asserts that nodes 10 and 21 (the WanVideoBlockSwap->WanVideoSetBlockSwap pair) are
classified dead-end on the first pass.
"""
import json
import os
import sys

ART = "/home/intel/tianfeng/comfy/ComfyUI/agent-demo/workspaces/ca76e727-68f6-45da-8c8b-bb46c70161bc/artifacts"
PROMPT = os.path.join(ART, "06-source-preserving-prompt.json")
OBJECT_INFO = os.path.join(ART, "05-object_info.json")


def is_link(v):
    return isinstance(v, list) and len(v) >= 1 and isinstance(v[0], str)


def main():
    with open(PROMPT) as f:
        raw = json.load(f)
    prompt = raw.get("prompt", raw)
    with open(OBJECT_INFO) as f:
        oi = json.load(f)

    # Step 1: output roots via OUTPUT_NODE registry (validate_prompt semantics).
    output_roots = []
    for nid, node in prompt.items():
        ctype = node.get("class_type")
        if oi.get(ctype, {}).get("output_node") is True:
            output_roots.append(nid)

    # Step 2: upstream trace from each output root.
    live = set()

    def visit(nid):
        if nid in live:
            return
        live.add(nid)
        for v in prompt[nid].get("inputs", {}).values():
            if is_link(v):
                visit(v[0])

    for root in output_roots:
        visit(root)

    # Step 3: dead-end = API-prompt nodes not in live set.
    dead_end = sorted((set(prompt) - live), key=lambda x: int(x))

    print("output_roots:", sorted(output_roots, key=lambda x: int(x)))
    print("live_count:", len(live))
    print("dead_end:", dead_end)

    # Required validation: nodes 10 and 21 classified dead-end on first pass.
    missing = [n for n in ("10", "21") if n not in dead_end]
    if missing:
        print("FAIL: expected nodes 10 and 21 to be dead-end; missing:", missing)
        sys.exit(1)
    # Sanity: 14/39/40 must be live (the real output roots).
    for n in ("14", "39", "40"):
        if n not in live:
            print("FAIL: output root", n, "not in live set")
            sys.exit(1)
    print("PASS: nodes 10 and 21 classified dead-end on first pass.")


if __name__ == "__main__":
    main()
