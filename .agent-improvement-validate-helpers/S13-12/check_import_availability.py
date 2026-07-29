#!/usr/bin/env python3
"""Step 06 import-availability pre-check validator for improvement S13-12.

Implements the optional pre-check added to 06-prompt-conversion-validation-skill.md:
scans a converted API prompt for widget values that select known CUDA-only
attention backends, attempts to import the backing module, and flags any that
are unavailable on the target device as `unavailable-on-<device>`.

This does NOT re-run the full Step 06 tool; it re-runs the new pre-check in
isolation against the task's real source-preserving prompt and environment
artifacts to confirm sageattn is flagged.

Usage:
    python3 check_import_availability.py <source-preserving-prompt.json> <05-environment-summary.json>
"""
import importlib
import json
import sys


# widget value -> (python module to import, display package name)
CUDA_ONLY_ATTENTION = {
    "sageattn": ("sageattention", "sageattention"),
    "sageattention": ("sageattention", "sageattention"),
    "flash_attn": ("flash_attn", "flash_attn"),
    "flash_attention": ("flash_attn", "flash_attn"),
    "xformers": ("xformers", "xformers"),
}


def detect_device(env_summary_path):
    try:
        with open(env_summary_path) as f:
            env = json.load(f)
    except (OSError, ValueError):
        return "unknown"
    if env.get("xpu_available"):
        return "xpu"
    if env.get("cuda_available"):
        return "cuda"
    return "unknown"


def scan_prompt(prompt_path):
    with open(prompt_path) as f:
        prompt = json.load(f)
    hits = []
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "?")
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        for input_name, value in inputs.items():
            if isinstance(value, str) and value in CUDA_ONLY_ATTENTION:
                module_name, pkg_name = CUDA_ONLY_ATTENTION[value]
                hits.append({
                    "node_id": node_id,
                    "class_type": class_type,
                    "input_name": input_name,
                    "value": value,
                    "module": module_name,
                    "package": pkg_name,
                })
    return hits


def try_import(module_name):
    try:
        importlib.import_module(module_name)
        return True, None
    except Exception as exc:  # ModuleNotFoundError or any import-time failure
        return False, f"{type(exc).__name__}: {exc}"


def main():
    if len(sys.argv) != 3:
        print("usage: check_import_availability.py <prompt.json> <env-summary.json>",
              file=sys.stderr)
        return 2
    prompt_path, env_summary_path = sys.argv[1], sys.argv[2]
    device = detect_device(env_summary_path)
    hits = scan_prompt(prompt_path)
    warnings = []
    for hit in hits:
        ok, err = try_import(hit["module"])
        if not ok:
            warnings.append({
                "node_id": hit["node_id"],
                "class_type": hit["class_type"],
                "input_name": hit["input_name"],
                "value": hit["value"],
                "module": hit["module"],
                "import_error": err,
                "flag": f"unavailable-on-{device}",
            })
    report = {
        "device": device,
        "scanned_prompt": prompt_path,
        "candidates_found": len(hits),
        "import_availability_warnings": warnings,
        "sageattn_flagged_unavailable": any(
            w["value"] in ("sageattn", "sageattention") for w in warnings
        ),
    }
    print(json.dumps(report, indent=2))
    # Exit non-zero if sageattn was NOT flagged, so the validation command fails loudly.
    return 0 if report["sageattn_flagged_unavailable"] else 1


if __name__ == "__main__":
    sys.exit(main())
