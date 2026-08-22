#!/usr/bin/env python3
"""Step 09 performance tuning -- config-aware and truthful.

Reads the hardened ``effective-run-config.json`` (the delivery BKC from the Step
07/08 capacity ladder + reduced-tier decision) and reports the ACTUAL delivered
runtime config, not a hardcoded default. When the workflow is capacity-locked to a
reduced tier + offload flags (e.g. WAN2.2 at ``--lowvram``), there is no lossless
tuning headroom to find -- so Step 09's honest job is to (a) state the locked
delivery config, and (b) back it with ONE clean same-config telemetry sample.

Where the sample comes from: Step 08 defers its inline reduced-validation when the
full-size probe DEVICE_LOSTs the XPU (``needs_reset``). By the time Step 09 runs,
the orchestrator has reset the XPU and reconciled the container to the persisted
``--lowvram`` flags (see comfyuiLifecycle.ensureComfyUiUp's flag-drift branch), so
this tool can run the deferred reduced-validation probe once on the clean server and
record the real reduced+``--lowvram`` peak/duration. If ``--api-url`` is not provided
(or a valid Step 08 verdict already exists), it does NOT run a render -- it reuses the
existing verdict or reports the empirical check as deferred to the Step 12 run.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from step07_branch_smoke import artifact_record, fetch_json, read_json, write_json
from step08_full_validation import infer_usable_budget_bytes, run_reduced_validation_probe


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json_safe(path: Path) -> dict[str, Any]:
    try:
        data = read_json(path)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def status_of(summary: dict[str, Any]) -> tuple[str | None, bool]:
    status = (summary.get("history_summary") or {}).get("status", {})
    return status.get("status_str"), bool(status.get("completed"))


def candidate_from_summary(name: str, path: Path, summary: dict[str, Any]) -> dict[str, Any]:
    status_str, completed = status_of(summary)
    decision_status = summary.get("completion_decision", {}).get("status")
    node_accounting = summary.get("node_accounting", {})
    output_count = len(summary.get("output_files", []))
    cached_count = len(summary.get("cached_nodes", []))
    executed_count = len(summary.get("executed_nodes", []))
    telemetry = summary.get("memory_runtime", {})
    unaccounted = node_accounting.get("unaccounted_node_ids", [])
    report_recovery_only = (
        status_str == "success"
        and completed
        and output_count > 0
        and set(unaccounted).issubset({"198"})
        and decision_status != "complete"
    )
    if decision_status == "complete":
        result = "accepted"
    elif report_recovery_only:
        result = "runtime_success_report_accounting_recovery"
    else:
        result = "rejected_or_failed"
    return {
        "name": name,
        "path": str(path),
        "decision_status": decision_status,
        "history_status": status_str,
        "history_completed": completed,
        "result_class": summary.get("result_class"),
        "run_level": summary.get("run_level"),
        "duration_seconds": summary.get("duration_seconds"),
        "cached_node_count": cached_count,
        "executed_node_count": executed_count,
        "output_files": output_count,
        "peak_memory_budget_ratio": telemetry.get("peak_memory_budget_ratio"),
        "peak_memory_used_mib": telemetry.get("peak_memory_used_mib"),
        "unaccounted_node_ids": unaccounted,
        "result": result,
        "cache_policy": "cache_assisted" if cached_count else "cold_or_cache_cleared",
        "telemetry_valid": bool(telemetry.get("valid_samples", 0)),
    }


def collect_candidates(artifact_dir: Path) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    current_path = artifact_dir / "08-full-validation-summary.json"
    current = read_json_safe(current_path)
    if current:
        candidates.append(candidate_from_summary("accepted-step08-current", current_path, current))

    attempts_root = artifact_dir / "08-full-validation" / "previous-attempts"
    if attempts_root.is_dir():
        for run_summary in sorted(attempts_root.glob("*/08-*-run-summary.json")):
            summary = read_json_safe(run_summary)
            candidates.append(candidate_from_summary(run_summary.parent.name, run_summary, summary))
    return candidates


def existing_reduced_verdict(artifact_dir: Path, cfg: dict[str, Any]) -> dict[str, Any] | None:
    """A reduced-validation verdict already produced upstream (Step 08 inline probe or
    the effective-run-config validation block), if it has a usable result."""
    val = ((cfg.get("recommended_reduced_setting") or {}).get("validation")) or {}
    if isinstance(val, dict) and (
        val.get("validated") is not None or val.get("reduced_peak_memory_budget_ratio") is not None
    ):
        return val
    s08 = read_json_safe(artifact_dir / "08-full-validation-summary.json")
    cap = (s08.get("completion_decision", {}) or {}).get("capacity", {}) or {}
    rv = cap.get("reduced_validation") or (s08.get("step12_context", {}) or {}).get("reduced_validation")
    if isinstance(rv, dict) and (
        rv.get("validated") is not None or rv.get("reduced_peak_memory_budget_ratio") is not None
    ):
        return rv
    return None


def reduced_delivery_baseline(
    artifact_dir: Path,
    cfg: dict[str, Any],
    api_url: str | None,
    comfy_root: Path | None,
    seed: int,
    timeout_seconds: int,
    poll_interval: float,
) -> dict[str, Any]:
    """Produce/read the delivered reduced + persisted-flags telemetry sample.

    Order: (1) run a FRESH probe on the current server (needs ``--api-url``) -- by Step
    09 the orchestrator has reconciled the container to the persisted ``--lowvram`` flags,
    so this measures the config ON THE DELIVERED FLAGS; (2) else reuse an upstream Step 08
    verdict as a fallback -- but note it may have been measured on DIFFERENT flags (Step
    08's reduced-validation runs before the reduced tier pins ``--lowvram``, so it can read
    over-budget without offload); (3) else defer to the Step 12 acceptance run. Never raises.

    A fresh probe is preferred over the upstream verdict precisely because the upstream one
    is often off-flags: e.g. it read 102.59% of budget without ``--lowvram`` while the
    delivered ``--lowvram`` config fits ~29 GB (real: task 0804a33f)."""
    if not cfg.get("reduced_tier"):
        return {"source": "not_reduced", "validated": None}

    existing = existing_reduced_verdict(artifact_dir, cfg)
    reduced_path = cfg.get("reduced_prompt_path")
    changes = ((cfg.get("recommended_reduced_setting") or {}).get("changes")) or []

    if api_url and reduced_path and Path(reduced_path).is_file() and changes:
        try:
            reduced_prompt = read_json(Path(reduced_path))
            stats = fetch_json(f"{api_url}/system_stats")
            budget = infer_usable_budget_bytes(stats if isinstance(stats, dict) else {}, None)
            run_dir = artifact_dir / "09-reduced-validation"
            run_dir.mkdir(parents=True, exist_ok=True)
            rv = run_reduced_validation_probe(
                api_url=api_url,
                source_prompt=reduced_prompt,
                changes=changes,
                run_dir=run_dir,
                comfy_root=(comfy_root or Path(".")).resolve(),
                usable_budget_bytes=budget,
                seed=seed,
                timeout_seconds=timeout_seconds,
                poll_interval_seconds=poll_interval,
            )
            # Measured on the delivered flags (the current server). Keep the upstream
            # note for traceability, but this fresh sample is authoritative.
            result = {"source": "step09", **rv}
            if existing is not None:
                result["prior_step08_note"] = existing.get("note")
            return result
        except Exception as exc:  # noqa: BLE001 - best-effort; fall back to any upstream verdict
            if existing is not None:
                return {"source": "step08_fallback", "step09_probe_error": str(exc), **existing}
            return {"source": "step09_error", "validated": None, "error": str(exc)}

    if existing is not None:
        # No live server to probe -- reuse the upstream verdict, flagged as possibly off-flags.
        return {
            "source": "step08",
            "off_flags_warning": (
                "reused Step 08 verdict; it may have been measured on different VRAM flags than "
                "the delivered policy (run Step 09 with --api-url for a delivered-flags sample)."
            ),
            **existing,
        }

    return {
        "source": "deferred",
        "validated": None,
        "note": (
            "No --api-url provided or reduced prompt/changes missing; the empirical "
            "reduced + delivered-flags validation is deferred to the Step 12 acceptance run."
        ),
    }


def delivery_default(cfg: dict[str, Any]) -> dict[str, Any]:
    """The ACTUAL delivered runtime config, read from effective-run-config.json --
    never a hardcoded per-workflow default."""
    flags = cfg.get("vram_flags") or []
    launch = " ".join(str(f) for f in flags) if flags else "(node default)"
    reduced = cfg.get("recommended_reduced_setting") or {}
    changes = reduced.get("changes") or []
    return {
        "launch_policy": (
            f"launch ComfyUI with `{launch}` (hardened by the Step 07/08 capacity ladder; "
            "lossless placement-only flags)"
        ),
        "vram_flags": list(flags),
        "reduced_tier": bool(cfg.get("reduced_tier")),
        "reduced_setting": {
            "resolution": reduced.get("resolution"),
            "frames": reduced.get("frames") or reduced.get("length"),
            "changes": changes,
        }
        if cfg.get("reduced_tier")
        else None,
        "prompt_policy": (
            "deliver reduced-runtime-policy-prompt.json (deterministically reduced) at "
            f"`{cfg.get('reduced_prompt_path')}`"
            if cfg.get("reduced_tier")
            else "deliver the Step 06 runtime-policy prompt at full size"
        ),
        "cache_policy": "do not require model/cache residency for single-run delivery",
    }


def choose_config(candidates: list[dict[str, Any]], cfg: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    valid_successes = [
        item
        for item in candidates
        if item["history_status"] == "success"
        and item["history_completed"]
        and item["result"] in {"accepted", "runtime_success_report_accounting_recovery"}
    ]
    fastest = min(
        valid_successes,
        key=lambda item: item.get("duration_seconds") or float("inf"),
        default=None,
    )

    flags = " ".join(str(f) for f in (cfg.get("vram_flags") or [])) or "(node default)"
    reduced_tier = bool(cfg.get("reduced_tier"))
    validated = baseline.get("validated")
    ratio = baseline.get("reduced_peak_memory_budget_ratio")
    peak_mib = baseline.get("reduced_peak_memory_used_mib")

    if not reduced_tier:
        selected = "full-size-delivery"
        reason = (
            f"Full-size delivery at `{flags}`. No lossy reduction was needed on this GPU; "
            "the delivered prompt is the Step 06 runtime-policy prompt at full size."
        )
    elif validated is True:
        selected = "validated-reduced-lowvram"
        reason = (
            f"Capacity-locked to the reduced tier + `{flags}` (offload is mandatory for this "
            f"model on this GPU). The reduced config was RUN on the delivered flags and cleared "
            f"OOM (reduced peak ≈ {ratio} of budget). There is NO lossless tuning headroom to "
            "promote -- a faster run needs a larger-VRAM / multi-GPU node, not a launch tweak."
        )
    elif validated is False:
        selected = "reduced-lowvram-marginal"
        reason = (
            f"Reduced tier + `{flags}`, but the reduced config did NOT clear cleanly when run "
            f"(reduced peak ≈ {ratio} of budget / OOM signature). Reduce frames further or "
            "escalate the VRAM tier before Step 12; do not promote a runtime speed change."
        )
    else:
        selected = "reduced-lowvram-unvalidated"
        ran = baseline.get("reduced_run_succeeded")
        telemetry_available = baseline.get("telemetry_available")
        if ran:
            # The reduced config DID run to completion; we just could not measure its
            # peak. Say so honestly ("ran OK, fit unconfirmed") rather than "never ran".
            fit_state = (
                "The reduced config RAN to completion on the delivered flags, but its VRAM fit "
                "is unconfirmed"
                + (
                    " (telemetry unavailable -- no peak/budget ratio was measured)"
                    if telemetry_available is False
                    else ""
                )
                + "; the Step 12 acceptance run confirms it."
            )
        else:
            fit_state = (
                "The reduced config was NOT run here (empirical same-config telemetry is "
                f"{baseline.get('source', 'unavailable')}); the Step 12 acceptance run confirms "
                "the reduced config on the delivered flags."
            )
        reason = (
            f"Capacity-locked to the reduced tier + `{flags}`. {fit_state} "
            f"({baseline.get('note', '')}). No lossless tuning headroom is claimed without a "
            "same-config sample."
        )

    return {
        "selected_configuration": selected,
        "selected_reason": reason.strip(),
        "delivery_default": delivery_default(cfg),
        "reduced_validation_baseline": {
            "source": baseline.get("source"),
            "validated": validated,
            "reduced_capacity_tier": baseline.get("reduced_capacity_tier"),
            "reduced_peak_memory_budget_ratio": ratio,
            "reduced_peak_memory_used_mib": peak_mib,
            "reduced_run_status": baseline.get("reduced_run_status"),
            "reduced_run_succeeded": baseline.get("reduced_run_succeeded"),
            "telemetry_available": baseline.get("telemetry_available"),
            "note": baseline.get("note") or baseline.get("error"),
        },
        "fastest_observed_candidate": fastest,
        "rejected_changes": [
            {
                "candidate": "cache-assisted speed as a universal tuning winner",
                "reason": "cache-assisted duration is not a lossless, reproducible speedup; not promoted.",
            },
            {
                "candidate": "drop offload flags to go faster",
                "reason": (
                    f"the capacity ladder proved `{flags}` is required to fit; dropping offload "
                    "re-introduces the OOM. Offload is lossless (placement only), so it is kept."
                ),
            },
        ],
    }


def completion_decision(
    candidates: list[dict[str, Any]], selection: dict[str, Any], cfg: dict[str, Any]
) -> dict[str, Any]:
    has_delivery_config = bool(cfg.get("vram_flags")) and (
        (not cfg.get("reduced_tier")) or bool(cfg.get("reduced_prompt_path"))
    )
    baseline = selection.get("reduced_validation_baseline", {})
    # Complete when we can state a concrete delivered config. A reduced tier without a
    # persisted reduced prompt is a real gap (Step 08 must have shipped structured
    # changes) -> hard_stop so we never claim a config we cannot deliver.
    status = "complete" if has_delivery_config else "hard_stop"
    return {
        "status": status,
        "success_criteria_checked": {
            "effective_run_config_consumed": bool(cfg),
            "delivery_config_resolved": has_delivery_config,
            "reduced_tier": bool(cfg.get("reduced_tier")),
            "reduced_validation_source": baseline.get("source"),
            "reduced_validation_validated": baseline.get("validated"),
            "candidate_attempts_collected": len(candidates),
            "selected_configuration": selection["selected_configuration"],
        },
        "unresolved_gaps": []
        if status == "complete"
        else ["Step 09 could not resolve a concrete delivery config from effective-run-config.json."],
        "human_gate_prompt": None
        if status == "complete"
        else {
            "problem_summary": "Step 09 has no deliverable runtime config (missing vram_flags or reduced prompt).",
            "required_human_action": "Re-run Step 08 so it hardens vram_flags + a structured reduced prompt, then retry.",
            "safe_reply_template": "Step 09 decision: <re-run Step 08 / approve config>; details: <...>.",
        },
        "next_step_allowed": status == "complete",
        "next_step": "10-coverage-review" if status == "complete" else None,
    }


def make_report(summary: dict[str, Any], report_path: Path) -> None:
    sel = summary["selection"]
    baseline = sel["reduced_validation_baseline"]
    lines = [
        "# Step 09 Performance Tuning",
        "",
        f"- Status: `{summary['completion_decision']['status']}`",
        f"- Selected configuration: `{sel['selected_configuration']}`",
        f"- Reduced tier: `{summary['effective_run_config'].get('reduced_tier')}`",
        f"- Delivered VRAM flags: `{' '.join(str(f) for f in summary['effective_run_config'].get('vram_flags') or []) or '(node default)'}`",
        f"- Candidate attempts: `{len(summary['candidates'])}`",
        "",
        "## Decision",
        "",
        sel["selected_reason"],
        "",
        "## Delivered runtime config (from effective-run-config.json)",
        "",
        f"- Launch policy: {sel['delivery_default']['launch_policy']}",
        f"- Prompt policy: {sel['delivery_default']['prompt_policy']}",
    ]
    if sel["delivery_default"].get("reduced_setting"):
        rs = sel["delivery_default"]["reduced_setting"]
        lines.append(f"- Reduced setting: resolution `{rs.get('resolution')}`, frames `{rs.get('frames')}`")
    lines.extend(
        [
            "",
            "## Reduced + delivered-flags validation sample",
            "",
            f"- Source: `{baseline.get('source')}`",
            f"- Validated: `{baseline.get('validated')}`",
            f"- Reduced peak / budget: `{baseline.get('reduced_peak_memory_budget_ratio')}`",
            f"- Reduced peak MiB: `{baseline.get('reduced_peak_memory_used_mib')}`",
            f"- Note: {baseline.get('note')}",
            "",
            "## Candidate matrix",
            "",
            "| candidate | result | cache policy | duration s | peak/budget | outputs |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
    )
    for item in summary["candidates"]:
        lines.append(
            "| {name} | {result} | {cache} | {duration} | {ratio} | {outputs} |".format(
                name=item["name"],
                result=item["result"],
                cache=item["cache_policy"],
                duration=item.get("duration_seconds"),
                ratio=item.get("peak_memory_budget_ratio"),
                outputs=item.get("output_files"),
            )
        )
    lines.extend(
        [
            "",
            "## Reflection",
            "",
            "- Step 09 reports the ACTUAL delivered config from effective-run-config.json, not a "
            "hardcoded default. When the workflow is capacity-locked to a reduced tier + offload "
            "flags, there is no lossless tuning headroom to promote -- a faster run needs more VRAM.",
            "- Offload flags (--lowvram/--novram) are lossless (placement only); they are kept, not "
            "tuned away. Cache-assisted speed is not promoted as a universal winner.",
            "",
            "## Completion decision",
            "",
            "```json",
            json.dumps(summary["completion_decision"], ensure_ascii=False, indent=2),
            "```",
        ]
    )
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Step 09 config-aware performance tuning.")
    parser.add_argument("--workspace", type=Path, required=True, help="Migration task workspace root.")
    parser.add_argument("--comfy-root", type=Path, default=None, help="ComfyUI root (for output-path resolution).")
    parser.add_argument(
        "--api-url",
        type=str,
        default=None,
        help="ComfyUI API base URL. When given and no upstream verdict exists, run the deferred "
        "reduced-validation probe once on the (already --lowvram) server.",
    )
    parser.add_argument("--timeout-seconds", type=int, default=1200)
    parser.add_argument("--smoke-seed", type=int, default=42)
    parser.add_argument("--poll-interval", type=float, default=2.0)
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    artifact_dir = workspace / "artifacts"
    cfg = read_json_safe(artifact_dir / "effective-run-config.json")
    candidates = collect_candidates(artifact_dir)
    baseline = reduced_delivery_baseline(
        artifact_dir,
        cfg,
        args.api_url,
        args.comfy_root,
        args.smoke_seed,
        args.timeout_seconds,
        args.poll_interval,
    )
    selection = choose_config(candidates, cfg, baseline)
    decision = completion_decision(candidates, selection, cfg)

    summary_path = artifact_dir / "09-tuning-analysis.json"
    report_path = artifact_dir / "09-tuning.md"
    manifest_path = artifact_dir / "09-output-manifest.json"

    summary = {
        "generated_at": utc_now(),
        "workspace": str(workspace),
        "tool_path": str(Path(__file__).resolve()),
        "command_used": f"{Path(__file__).resolve()} --workspace {workspace}"
        + (f" --api-url {args.api_url}" if args.api_url else ""),
        "baseline": str(artifact_dir / "08-full-validation-summary.json"),
        "effective_run_config": {
            "reduced_tier": bool(cfg.get("reduced_tier")),
            "vram_flags": list(cfg.get("vram_flags") or []),
            "vram_level": cfg.get("vram_level"),
            "reduced_prompt_path": cfg.get("reduced_prompt_path"),
            "recommended_reduced_setting": cfg.get("recommended_reduced_setting"),
        },
        "candidates": candidates,
        "selection": selection,
        "claim_boundary": {
            "run_level": "reduced-delivered-flags" if cfg.get("reduced_tier") else "full-size",
            "delivered_flags": list(cfg.get("vram_flags") or []),
            "source_boundary": "runtime-policy prompt variant; source workflow unchanged",
            "full_size_capacity": "not customer-ready" if cfg.get("reduced_tier") else "delivered",
        },
        "step10_context": {
            "workspace": str(workspace),
            "artifact_folder": str(artifact_dir),
            "step09_summary": str(summary_path),
            "step08_summary": str(artifact_dir / "08-full-validation-summary.json"),
            "selected_configuration": selection["selected_configuration"],
            "delivered_vram_flags": list(cfg.get("vram_flags") or []),
            "reduced_tier": bool(cfg.get("reduced_tier")),
            "coverage_boundary": (
                "coverage uses the reduced + delivered-flags evidence only; do not claim full-size "
                "or source-identical success"
                if cfg.get("reduced_tier")
                else "coverage uses the full-size delivered evidence"
            ),
        },
        "completion_decision": decision,
    }
    write_json(summary_path, summary)
    make_report(summary, report_path)
    manifest = {
        "generated_at": utc_now(),
        "step": "09",
        "status": decision["status"],
        "artifacts": [artifact_record(path) for path in [summary_path, report_path] if path.exists()],
        "completion_decision": decision,
        "step10_context": summary["step10_context"],
    }
    write_json(manifest_path, manifest)
    print(json.dumps({"status": decision["status"], "manifest": str(manifest_path)}, ensure_ascii=False))
    return 0 if decision["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())
