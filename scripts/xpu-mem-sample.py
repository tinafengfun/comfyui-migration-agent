#!/usr/bin/env python3
"""Accurate device-level Intel XPU memory sampler for the migration agent.

Samples RAW device memory via `xpu-smi` (not ComfyUI's /system_stats accounting,
which reflects ComfyUI's own estimate rather than true device usage). Emits one
normalized JSON line to stdout describing every XPU device:

  {"ok": true, "timestamp": <epoch_s>, "tool": "xpu-smi",
   "devices": [{"device_id": 0, "ok": true,
                "mem_used_mib": ..., "mem_total_mib": ..., "mem_used_pct": ...,
                "mem_util_pct": ..., "gpu_util_pct": ..., "power_w": ..., "temp_c": ...}]}

Used by the backend (GET /api/gpu-nodes/:name/xpu-memory, polled live by the web
UI) and runnable standalone on a GPU node. Falls back to ok:false (never raises)
so a non-XPU / no-xpu-smi node degrades gracefully in the UI.

Usage: xpu-mem-sample.py            # all devices
       xpu-mem-sample.py 0          # a specific device id
"""
import json
import subprocess
import sys
import time


def _run(args, timeout=8):
    try:
        p = subprocess.run(["xpu-smi", *args], capture_output=True, text=True, timeout=timeout)
        if p.returncode != 0 or not p.stdout.strip():
            return None
        return json.loads(p.stdout)
    except Exception:
        return None


def _device_ids():
    d = _run(["discovery", "-j"])
    if isinstance(d, dict):
        lst = d.get("device_list") or d.get("devices") or []
        ids = [x.get("device_id") for x in lst if isinstance(x, dict) and x.get("device_id") is not None]
        if ids:
            return ids
    return [0]


def _disc_info(dev):
    """Return (total_mib, device_name) from discovery for a device."""
    d = _run(["discovery", "-d", str(dev), "-j"])
    if not isinstance(d, dict):
        return None, None
    b = d.get("memory_physical_size_byte")
    try:
        total = round(float(b) / 1048576.0, 1) if b else None
    except (TypeError, ValueError):
        total = None
    return total, d.get("device_name")


def _sample(dev):
    out = {"device_id": dev, "ok": False}
    s = _run(["stats", "-d", str(dev), "-j"])
    if not isinstance(s, dict):
        return out
    metrics = {m.get("metrics_type"): m.get("value")
               for m in s.get("device_level", []) if isinstance(m, dict)}
    used = metrics.get("XPUM_STATS_MEMORY_USED")
    total, device_name = _disc_info(dev)
    used_pct = None
    if used is not None and total:
        try:
            used_pct = round(float(used) / float(total) * 100.0, 1)
        except (TypeError, ValueError, ZeroDivisionError):
            used_pct = None
    out.update({
        "ok": True,
        "device_name": device_name,
        "mem_used_mib": used,
        "mem_total_mib": total,
        "mem_used_pct": used_pct,
        "mem_util_pct": metrics.get("XPUM_STATS_MEMORY_UTILIZATION"),
        "gpu_util_pct": metrics.get("XPUM_STATS_GPU_UTILIZATION"),
        "power_w": metrics.get("XPUM_STATS_POWER"),
        "temp_c": metrics.get("XPUM_STATS_GPU_CORE_TEMPERATURE"),
    })
    return out


def main():
    devs = [int(sys.argv[1])] if len(sys.argv) > 1 else _device_ids()
    devices = [_sample(d) for d in devs]
    any_ok = any(d.get("ok") for d in devices)
    print(json.dumps({
        "ok": any_ok,
        "timestamp": int(time.time()),
        "tool": "xpu-smi",
        "devices": devices,
        **({} if any_ok else {"error": "xpu-smi returned no usable device stats (not an XPU node or xpu-smi unavailable)"}),
    }))


if __name__ == "__main__":
    main()
