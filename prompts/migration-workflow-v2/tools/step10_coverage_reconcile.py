#!/usr/bin/env python3
"""Step 10 coverage reconciliation — deterministic tool.

Reads:
  1. 03-inventory.md          — source workflow node inventory (markdown table)
  2. Full-run history JSON    — executed/cached evidence from a full validation run
  3. Branch-smoke history     — per-branch smoke test histories (one or more)

Writes:
  10-node-coverage.csv        — per-node coverage status
  10-coverage-summary.json    — aggregate counts and completion decision

Handles both flat-dict history ({"prompt": [...], "outputs": {...}, ...})
and prompt_id-keyed history ({"<prompt_id>": {"prompt": [...], ...}}).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


# ── markdown table parser ──────────────────────────────────────────────

def parse_markdown_table(md_text: str) -> list[dict[str, str]]:
    """Extract the first pipe-table from *md_text* and return a list of rows."""
    lines = md_text.splitlines()
    table_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|"):
            # skip separator rows — all cells contain only dashes / colons / spaces
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if all(re.fullmatch(r"[\s\-:]+", c) for c in cells):
                continue
            table_lines.append(stripped)

    if not table_lines:
        return []

    # header
    header = [cell.strip() for cell in table_lines[0].strip("|").split("|")]
    rows: list[dict[str, str]] = []
    for row_line in table_lines[1:]:
        cells = [cell.strip() for cell in row_line.strip("|").split("|")]
        row: dict[str, str] = {}
        for i, col in enumerate(header):
            row[col] = cells[i] if i < len(cells) else ""
        rows.append(row)
    return rows


# ── inventory parsing ──────────────────────────────────────────────────

def parse_inventory(md_path: Path) -> list[dict[str, str]]:
    """Parse 03-inventory.md and return a list of node dicts with at least
    *id*, *type*, and (optionally) *role*, *pkg*, *linked*."""
    text = md_path.read_text(encoding="utf-8")

    # Find the "## Node inventory" section and collect all pipe-table lines
    # within it.  Feed those lines directly to parse_markdown_table which
    # correctly handles header / separator / data rows.
    section_lines: list[str] = []
    in_section = False
    for line in text.splitlines():
        stripped = line.strip()
        if re.match(r"## Node inventory", stripped, re.IGNORECASE):
            in_section = True
            continue
        if in_section:
            if stripped.startswith("##"):
                break  # next heading
            if stripped.startswith("|"):
                section_lines.append(stripped)

    if not section_lines:
        print("WARNING: no pipe lines found in Node inventory section", file=sys.stderr)
        return []

    table_text = "\n".join(section_lines)
    rows = parse_markdown_table(table_text)
    # Normalise column names to lowercase keys
    normalized: list[dict[str, str]] = []
    for row in rows:
        nr: dict[str, str] = {}
        for k, v in row.items():
            nr[k.strip().lower()] = v.strip()
        normalized.append(nr)
    return normalized


# ── history helpers ────────────────────────────────────────────────────

def normalize_history(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalise a history JSON to the flat-dict form
    {prompt, outputs, status, meta}.

    If the root dict has a single key that looks like a UUID prompt_id
    (prompt_id-keyed format), unwrap it.
    """
    if "prompt" in raw:
        return raw  # already flat-dict
    # prompt_id-keyed: {"<uuid>": {...}}
    uuid_pat = re.compile(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        re.IGNORECASE,
    )
    for key, val in raw.items():
        if uuid_pat.match(key) and isinstance(val, dict) and "prompt" in val:
            return val
    # Last resort: first value that looks like a history entry
    for val in raw.values():
        if isinstance(val, dict) and "prompt" in val:
            return val
    raise ValueError("Cannot normalise history JSON: unknown format")


def extract_prompt_nodes(history: dict[str, Any]) -> set[str]:
    """Return the set of node ID strings from the history prompt."""
    prompt = history.get("prompt", [])
    if isinstance(prompt, list) and len(prompt) >= 3 and isinstance(prompt[2], dict):
        return set(prompt[2].keys())
    return set()


def extract_prompt_class_types(history: dict[str, Any]) -> dict[str, str]:
    """Return a dict mapping node_id -> class_type from the prompt."""
    prompt = history.get("prompt", [])
    if isinstance(prompt, list) and len(prompt) >= 3 and isinstance(prompt[2], dict):
        return {
            nid: node.get("class_type", "")
            for nid, node in prompt[2].items()
        }
    return {}


def extract_partial_execution_targets(history: dict[str, Any]) -> list[str]:
    """Return the list of partial execution targets (output node IDs)."""
    prompt = history.get("prompt", [])
    if isinstance(prompt, list) and len(prompt) >= 5 and isinstance(prompt[4], list):
        return [str(t) for t in prompt[4]]
    return []


def extract_cached_nodes(history: dict[str, Any]) -> set[str]:
    """Return the set of cached node ID strings from execution_cached messages."""
    status = history.get("status", {})
    for msg in status.get("messages", []):
        if isinstance(msg, list) and len(msg) >= 2 and msg[0] == "execution_cached":
            return set(str(n) for n in msg[1].get("nodes", []))
    return set()


def extract_output_nodes(history: dict[str, Any]) -> set[str]:
    """Return the set of node IDs that produced output."""
    outputs = history.get("outputs", {})
    return set(outputs.keys())


# Heuristic display-sink / structural classes that are in the prompt
# but not actually scheduled for runtime execution.
_DISPLAY_SINK_PREFIXES = (
    "Image Comparer",
    "PreviewImage",
    "ShowImage",
    "ViewImage",
    "Comparer",
)


def is_display_sink(class_type: str) -> bool:
    return class_type.startswith(_DISPLAY_SINK_PREFIXES)


# ── smoke evidence ────────────────────────────────────────────────────

def build_smoke_evidence(
    smoke_history_paths: list[Path],
) -> dict[str, dict[str, Any]]:
    """For each smoke history return a dict keyed by node_id with
    *executed_branches* and *cached_branches*."""
    evidence: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"executed_branches": [], "cached_branches": []}
    )
    for shp in smoke_history_paths:
        branch_name = shp.parent.name if shp.parent.name != shp.parent.parent.name else shp.stem
        # Extract branch name from path — prefer parent dir name
        # The smoke histories live under 07-branch-smokes/<branch>/...
        if shp.parent.parent.name.startswith("07-branch-smoke"):
            branch_name = shp.parent.name
        raw = read_json(shp)
        hist = normalize_history(raw)
        prompt_nodes = extract_prompt_nodes(hist)
        cached_nodes = extract_cached_nodes(hist)
        executed_nodes = prompt_nodes - cached_nodes
        for nid in executed_nodes:
            evidence[nid]["executed_branches"].append(branch_name)
        for nid in cached_nodes:
            evidence[nid]["cached_branches"].append(branch_name)
    return dict(evidence)


# ── inventory → node lookup ────────────────────────────────────────────

def build_node_map(inventory: list[dict[str, str]]) -> dict[str, dict[str, str]]:
    """Build a lookup dict keyed by node ID (as string)."""
    lookup: dict[str, dict[str, str]] = {}
    for row in inventory:
        nid = row.get("id", row.get("node_id", "")).strip()
        if nid:
            lookup[nid] = row
    return lookup


# ── classification ─────────────────────────────────────────────────────

def infer_role(inv_row: dict[str, str] | None, node_type: str, linked: str | None) -> str:
    """Derive a human-readable role label from the inventory row."""
    if inv_row:
        # Use explicit role if present
        if "role" in inv_row and inv_row["role"].strip():
            return inv_row["role"].strip()
        # Fall back to node type + context
        pkg = inv_row.get("package/source hint", inv_row.get("pkg", "")).strip()
        suffix = f" ({pkg})" if pkg else ""
        return f"{node_type}{suffix}"
    if linked and linked.lower() == "no":
        return f"{node_type} (disconnected)"
    return node_type


def classify_node(
    nid: str,
    inv_row: dict[str, str] | None,
    full_prompt_nodes: set[str],
    full_exec_nodes: set[str],
    full_cached_nodes: set[str],
    full_output_nodes: set[str],
    full_class_types: dict[str, str],
    full_prompt_targets: list[str],
    smoke_ev: dict[str, Any],
) -> dict[str, str]:
    """Classify a single node and return the coverage row fields."""
    node_type = inv_row.get("type", "unknown") if inv_row else "unknown"
    linked = inv_row.get("linked?", "") if inv_row else ""
    role = infer_role(inv_row, node_type, linked)

    class_type = full_class_types.get(nid, "")

    # Check if node is a display sink not on the execution path
    is_display_sink_node = (
        nid in full_prompt_nodes
        and is_display_sink(class_type)
        and nid not in full_prompt_targets
        and nid not in full_output_nodes
    )

    # Determine full-run status
    if is_display_sink_node:
        full_run_status = "not_scheduled"
    elif nid in full_cached_nodes:
        full_run_status = "cached"
    elif nid in full_exec_nodes and not is_display_sink_node:
        full_run_status = "executed"
    else:
        full_run_status = "not_in_prompt" if nid not in full_prompt_nodes else "not_scheduled"

    # Smoke evidence
    sm = smoke_ev.get(nid, {"executed_branches": [], "cached_branches": []})
    smoke_exec_b = ";".join(sm.get("executed_branches", []))
    smoke_cached_b = ";".join(sm.get("cached_branches", []))
    has_smoke_exec = bool(sm.get("executed_branches", []))
    has_smoke_cached = bool(sm.get("cached_branches", []))
    has_output = "yes" if nid in full_output_nodes else "no"

    # Determine if node is excluded (disconnected / frontend-only)
    linked_no = linked.strip().lower() == "no"

    # Coverage status
    if is_display_sink_node:
        coverage_status = "excluded_display_sink"
        evidence = "display sink node in prompt but not scheduled"
        support = "GUI display node, no runtime output to validate"
    elif nid in full_exec_nodes and not is_display_sink_node:
        coverage_status = "covered_full_run_executed"
        evidence = "full-run execution history"
        support = "covered — executable node with cold full-run evidence"
    elif nid in full_cached_nodes:
        coverage_status = "covered_full_run_cached"
        evidence = "full-run cache evidence"
        support = "cache-assisted coverage; not cold-executed in accepted run"
    elif has_smoke_exec:
        coverage_status = "covered_smoke_only_executed"
        evidence = "branch-smoke execution history (not in full run)"
        support = "covered by branch smoke, not full accepted execution"
    elif has_smoke_cached:
        coverage_status = "covered_smoke_only_cached"
        evidence = "branch-smoke cache evidence"
        support = "cache-assisted smoke coverage only"
    elif has_output == "yes":
        coverage_status = "covered_output_only"
        evidence = "full-run output file evidence"
        support = "output evidence only"
    elif linked_no:
        coverage_status = "excluded_disconnected"
        evidence = "disconnected node in source workflow"
        support = "not on any execution path; excluded from runtime coverage"
    elif nid not in full_prompt_nodes:
        coverage_status = "excluded_not_in_prompt"
        evidence = "not present in generated prompt"
        support = "frontend-only or annotation node stripped during prompt conversion"
    else:
        coverage_status = "uncovered_executable"
        evidence = "none"
        support = "blocks release until covered or explicitly gated"

    return {
        "node_id": nid,
        "node_type": node_type,
        "role": role,
        "full_run_status": full_run_status,
        "smoke_executed_branches": smoke_exec_b,
        "smoke_cached_branches": smoke_cached_b,
        "output_evidence": has_output,
        "coverage_status": coverage_status,
        "evidence": evidence,
        "support_impact": support,
    }


# ── summary ────────────────────────────────────────────────────────────

def build_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    counts: dict[str, int] = defaultdict(int)
    for row in rows:
        counts[row["coverage_status"]] += 1

    uncovered = [r for r in rows if r["coverage_status"] == "uncovered_executable"]

    # Branch info from smoke evidence in rows
    branch_smoke_map: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row["smoke_executed_branches"]:
            for b in row["smoke_executed_branches"].split(";"):
                if b:
                    branch_smoke_map.setdefault(b, {"nodes": []})
                    branch_smoke_map[b]["nodes"].append(row["node_id"])

    return {
        "generated_at": utc_now(),
        "source_node_count": len(rows),
        "coverage_counts": dict(counts),
        "uncovered_executable_node_ids": [r["node_id"] for r in uncovered],
        "all_executable_nodes_classified": not uncovered,
        "full_run_nodes_executed": sum(
            1 for r in rows if r["full_run_status"] == "executed"
        ),
        "full_run_nodes_cached": sum(
            1 for r in rows if r["full_run_status"] == "cached"
        ),
        "output_evidence_count": sum(
            1 for r in rows if r["output_evidence"] == "yes"
        ),
        "completion_decision": {
            "status": "complete" if not uncovered else "hard_stop",
            "next_step_allowed": not uncovered,
            "unresolved_gaps": [
                f"uncovered executable nodes: {[r['node_id'] for r in uncovered]}"
            ]
            if uncovered
            else [],
        },
    }


# ── main ───────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Step 10 coverage reconciliation: inventory + history → coverage CSV & summary."
    )
    parser.add_argument(
        "--inventory",
        type=Path,
        required=True,
        help="Path to 03-inventory.md",
    )
    parser.add_argument(
        "--full-history",
        type=Path,
        required=True,
        help="Path to full-run history JSON (e.g. 08-full-run-history.json)",
    )
    parser.add_argument(
        "--smoke-histories",
        type=Path,
        nargs="*",
        default=[],
        help="Paths to branch-smoke history JSON files (e.g. 07-node-72-smoke-history.json …)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("."),
        help="Directory for output files (default: current directory)",
    )
    args = parser.parse_args()

    # Validate that input files exist before doing any work.
    missing: list[str] = []
    for label, path in [
        ("--inventory", args.inventory),
        ("--full-history", args.full_history),
    ]:
        if not path.is_file():
            missing.append(f"{label} (not found: {path})")
    for path in args.smoke_histories:
        if not path.is_file():
            missing.append(f"--smoke-histories (not found: {path})")
    if missing:
        print("ERROR: missing required inputs:\n  - " + "\n  - ".join(missing), file=sys.stderr)
        return 1

    output_dir = args.output_dir.resolve()

    # 1. Parse inventory
    inventory = parse_inventory(args.inventory)
    if not inventory:
        print("ERROR: no nodes parsed from inventory", file=sys.stderr)
        return 1
    node_map = build_node_map(inventory)
    all_inventory_ids = set(node_map.keys())

    # 2. Parse full-run history
    raw_full = read_json(args.full_history)
    full_hist = normalize_history(raw_full)
    full_prompt_nodes = extract_prompt_nodes(full_hist)
    full_class_types = extract_prompt_class_types(full_hist)
    full_prompt_targets = extract_partial_execution_targets(full_hist)
    full_cached_nodes = extract_cached_nodes(full_hist)
    full_exec_nodes = full_prompt_nodes - full_cached_nodes
    full_output_nodes = extract_output_nodes(full_hist)

    # 3. Parse smoke histories
    smoke_ev = build_smoke_evidence(args.smoke_histories)

    # 4. Classify every inventory node
    all_ids = all_inventory_ids | full_prompt_nodes  # include nodes in prompt but not inventory
    rows: list[dict[str, Any]] = []
    for nid in sorted(all_ids, key=lambda x: (0, int(x)) if x.isdigit() else (1, x)):
        inv_row = node_map.get(nid)
        row = classify_node(
            nid=nid,
            inv_row=inv_row,
            full_prompt_nodes=full_prompt_nodes,
            full_exec_nodes=full_exec_nodes,
            full_cached_nodes=full_cached_nodes,
            full_output_nodes=full_output_nodes,
            full_class_types=full_class_types,
            full_prompt_targets=full_prompt_targets,
            smoke_ev=smoke_ev,
        )
        rows.append(row)

    # 5. Write CSV
    fieldnames = [
        "node_id",
        "node_type",
        "role",
        "full_run_status",
        "smoke_executed_branches",
        "smoke_cached_branches",
        "output_evidence",
        "coverage_status",
        "evidence",
        "support_impact",
    ]
    csv_path = output_dir / "10-node-coverage.csv"
    write_csv(csv_path, rows, fieldnames)

    # 6. Write summary
    summary = build_summary(rows)
    summary["workspace_inventory"] = str(args.inventory.resolve())
    summary["full_history"] = str(args.full_history.resolve())
    summary["smoke_histories"] = [str(p.resolve()) for p in args.smoke_histories]

    summary_path = output_dir / "10-coverage-summary.json"
    write_json(summary_path, summary)

    print(
        json.dumps(
            {
                "status": summary["completion_decision"]["status"],
                "coverage_csv": str(csv_path),
                "summary_json": str(summary_path),
                "node_count": len(rows),
                "uncovered": summary["uncovered_executable_node_ids"],
            },
            ensure_ascii=False,
        )
    )
    return 0 if summary["completion_decision"]["next_step_allowed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
