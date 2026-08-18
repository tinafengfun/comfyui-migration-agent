#!/usr/bin/env python3
"""
validate_node_xpu.py — per-custom-node XPU validation harness.

The pipeline validates whole workflows / output branches (Step 07/08) but never a
single custom node, and it never asserts that a node ACTUALLY ran on the XPU vs
silently fell back to CPU (PYTORCH_ENABLE_XPU_FALLBACK=1 permits that). This tool
closes both gaps for the XPU-support catalog: given a workflow API prompt and one
or more target nodes, it executes just each node's subgraph
(`partial_execution_targets`), samples xpu-smi during the run, and FAILS a node
that was expected to run on XPU but shows near-zero GPU utilization (CPU-fallback
suspected). Its per-node verdicts are the catalog write-back evidence.

Runs SEQUENTIALLY (one node at a time): a single XPU cannot run two heavy prompts
at once, and ComfyUI is a single execution queue — so there is no parallel
fan-out here (see the plan). Reuses Step 07/08 primitives rather than
reimplementing submit/poll/telemetry.

Usage:
  validate_node_xpu.py --api-url http://127.0.0.1:8188 --prompt api-prompt.json \
    --node-type BerniniConditioning [--node-type ...] \
    [--node-id 34 ...] [--expect-execution xpu|cpu|hybrid] \
    [--xpu-util-threshold 15] [--comfy-root /path] [--report out.json] \
    [--timeout-seconds 600] [--poll-interval 2.0] [--no-reduce] [--node-key owner__pkg]

Exit 0 = every targeted node passed; non-zero = at least one failed / unreachable.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any

# Reuse the canonical execution + telemetry primitives (same tools dir).
from step07_branch_smoke import (  # type: ignore
    artifact_record,
    free_memory,
    post_json,
    read_json,
    scan_capacity_signature,
    summarize_history,
    utc_now,
    wait_history,
    write_json,
)
from step08_full_validation import (  # type: ignore
    TelemetryPoller,
    infer_usable_budget_bytes,
    telemetry_summary,
)

DEFAULT_XPU_UTIL_THRESHOLD = 15.0  # percent peak GPU util below which we suspect CPU fallback


def graph_of(prompt_doc: Any) -> dict[str, Any]:
    """Accept either a bare API graph or a {prompt: {...}} wrapper."""
    if isinstance(prompt_doc, dict) and isinstance(prompt_doc.get("prompt"), dict):
        return prompt_doc["prompt"]
    return prompt_doc


def find_target_node_ids(
    graph: dict[str, Any], node_ids: list[str], node_types: list[str]
) -> list[tuple[str, str]]:
    """Resolve (node_id, class_type) targets from explicit ids + class_type matches."""
    targets: list[tuple[str, str]] = []
    seen: set[str] = set()
    for nid in node_ids:
        node = graph.get(nid)
        if isinstance(node, dict) and nid not in seen:
            targets.append((nid, str(node.get("class_type", ""))))
            seen.add(nid)
    wanted = set(node_types)
    if wanted:
        for nid, node in graph.items():
            if not isinstance(node, dict):
                continue
            ct = str(node.get("class_type", ""))
            if ct in wanted and nid not in seen:
                targets.append((nid, ct))
                seen.add(nid)
    return targets


def reduce_steps(graph: dict[str, Any]) -> dict[str, Any]:
    """
    Cheap-ify: set any integer `steps` input to 1. Peak VRAM is per-forward and
    step-count-independent (the capacity doctrine), so this makes the probe fast
    WITHOUT changing whether the node fits or which device it runs on.
    """
    reduced = copy.deepcopy(graph)
    for node in reduced.values():
        if isinstance(node, dict):
            inputs = node.get("inputs")
            if isinstance(inputs, dict) and isinstance(inputs.get("steps"), int):
                inputs["steps"] = 1
    return reduced


def judge_verdict(
    *,
    completed: bool,
    status_success: bool,
    has_outputs: bool,
    capacity_signature: str | None,
    peak_gpu_util: float | None,
    expect_execution: str,
    threshold: float,
) -> dict[str, Any]:
    """
    Pure verdict logic (the novel part — unit tested). Priority:
      capacity signature > runtime failure > CPU-fallback-on-XPU > success.
    A node expected to run on XPU whose peak GPU utilization stayed below
    `threshold` is a suspected silent CPU fallback and FAILS.
    """
    ran_ok = bool(completed and status_success and has_outputs)
    capacity_suspected = capacity_signature is not None
    cpu_fallback_suspected = (
        expect_execution == "xpu"
        and peak_gpu_util is not None
        and peak_gpu_util < threshold
    )

    if capacity_suspected:
        result, passed = "capacity_suspected", False
    elif not ran_ok:
        result, passed = "failed_runtime", False
    elif cpu_fallback_suspected:
        result, passed = "cpu_fallback_suspected", False
    else:
        result, passed = "success", True

    return {
        "passed": passed,
        "historyResult": result,
        "xpuUtilizationPct": peak_gpu_util,
        "cpuFallbackSuspected": cpu_fallback_suspected,
        "capacitySuspected": capacity_suspected,
    }


def validate_one_node(
    graph: dict[str, Any],
    node_id: str,
    class_type: str,
    *,
    api_url: str,
    comfy_root: Path,
    expect_execution: str,
    threshold: float,
    timeout_seconds: int,
    poll_interval: float,
    reduce: bool,
    usable_budget_bytes: int | None,
) -> dict[str, Any]:
    """Execute just this node's subgraph, sample telemetry, and judge."""
    free_memory(api_url)  # unload models from the previous node
    submission = reduce_steps(graph) if reduce else copy.deepcopy(graph)
    prompt_id = f"nodeval-{node_id}-{utc_now().replace(':', '').replace('-', '')}"
    payload = {
        "prompt": submission,
        "prompt_id": prompt_id,
        "client_id": "validate-node-xpu",
        "partial_execution_targets": [node_id],
    }

    poller = TelemetryPoller(poll_interval)
    poller.start()
    submit_error: str | None = None
    history: dict[str, Any] = {}
    try:
        post_json(f"{api_url}/prompt", payload)
        history = wait_history(api_url, prompt_id, timeout_seconds, poll_interval)
    except Exception as exc:  # noqa: BLE001 — surface any submit/poll error as a verdict
        submit_error = str(exc)
    finally:
        poller.stop()

    tele = telemetry_summary(poller.samples, usable_budget_bytes)
    peak_util = tele.get("peak_gpu_utilization_percent")
    capacity_sig = scan_capacity_signature(history) if history else None

    if submit_error is not None:
        verdict = {
            "passed": False,
            "historyResult": "failed_runtime",
            "xpuUtilizationPct": peak_util,
            "cpuFallbackSuspected": False,
            "capacitySuspected": capacity_sig is not None,
            "error": submit_error,
        }
        summary: dict[str, Any] = {}
    else:
        summary = summarize_history(history, comfy_root)
        verdict = judge_verdict(
            completed=bool(summary.get("completed")),
            status_success=summary.get("status_str") == "success",
            has_outputs=bool(summary.get("output_files")),
            capacity_signature=capacity_sig,
            peak_gpu_util=peak_util,
            expect_execution=expect_execution,
            threshold=threshold,
        )

    return {
        "nodeId": node_id,
        "nodeType": class_type,
        "expectExecution": expect_execution,
        "capacitySignature": capacity_sig,
        "peakMemoryBudgetRatio": tele.get("peak_memory_budget_ratio"),
        "telemetrySamples": tele.get("valid_samples"),
        "passedAt": utc_now(),
        **verdict,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Per-custom-node XPU validation harness")
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--prompt", required=True, help="API prompt JSON (bare graph or {prompt:...})")
    parser.add_argument("--node-id", action="append", default=[], help="Target node id (repeatable)")
    parser.add_argument("--node-type", action="append", default=[], help="Target class_type (repeatable)")
    parser.add_argument("--expect-execution", default="xpu", choices=["xpu", "cpu", "hybrid"])
    parser.add_argument("--xpu-util-threshold", type=float, default=DEFAULT_XPU_UTIL_THRESHOLD)
    parser.add_argument("--comfy-root", default=".")
    parser.add_argument("--report", default="node-validation.json")
    parser.add_argument("--node-key", default=None, help="Catalog nodeKey this validation is for (evidence label)")
    parser.add_argument("--timeout-seconds", type=int, default=600)
    parser.add_argument("--poll-interval", type=float, default=2.0)
    parser.add_argument("--no-reduce", action="store_true", help="Do not set sampler steps=1")
    args = parser.parse_args()

    graph = graph_of(read_json(Path(args.prompt)))
    targets = find_target_node_ids(graph, args.node_id, args.node_type)
    if not targets:
        print("no target nodes matched --node-id/--node-type", file=sys.stderr)
        return 2

    comfy_root = Path(args.comfy_root)
    usable_budget = None
    try:
        from step07_branch_smoke import fetch_json  # local import to keep top clean

        usable_budget = infer_usable_budget_bytes(fetch_json(f"{args.api_url}/system_stats"), None)
    except Exception:  # noqa: BLE001 — budget is optional context
        usable_budget = None

    verdicts = [
        validate_one_node(
            graph,
            nid,
            ct,
            api_url=args.api_url,
            comfy_root=comfy_root,
            expect_execution=args.expect_execution,
            threshold=args.xpu_util_threshold,
            timeout_seconds=args.timeout_seconds,
            poll_interval=args.poll_interval,
            reduce=not args.no_reduce,
            usable_budget_bytes=usable_budget,
        )
        for nid, ct in targets
    ]

    all_passed = all(v["passed"] for v in verdicts)
    report_path = Path(args.report)
    report = {
        "generated_at": utc_now(),
        "api_url": args.api_url,
        "node_key": args.node_key,
        "expect_execution": args.expect_execution,
        "xpu_util_threshold": args.xpu_util_threshold,
        "all_passed": all_passed,
        "nodes": verdicts,
    }
    write_json(report_path, report)
    print(f"validated {len(verdicts)} node(s); all_passed={all_passed}; report -> {report_path}")
    for v in verdicts:
        print(f"  {v['nodeType']}#{v['nodeId']}: {v['historyResult']} (util={v['xpuUtilizationPct']}) passed={v['passed']}")
    report["artifact"] = artifact_record(report_path)
    return 0 if all_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
