#!/usr/bin/env python3
"""
Validation helper for improvement S13-16 (xpu-run-monitor.mts).

The "Required validation" items are:
  1. Run the monitor during a blocked-compute state and confirm it reports VRAM
     and active threads.
  2. Confirm it does not interfere with the running computation.

A real ComfyUI blocked-compute state cannot be replayed from the static artifact
directory, so this helper uses a faithful runnable proxy: it spawns a CPU-burning
child process (the same shape the monitor is designed for -- a process pegged at
~100% CPU), runs xpu-run-monitor.mts against that PID, and asserts:

  - the monitor reports a non-null VRAM reading (memUsedMib) and a thread count,
  - at least one sample shows increasing CPU time (activeCompute == true), and
  - the burned child is still alive AND its CPU time kept increasing *after* the
    monitor ran -- i.e. the read-only monitor did not perturb it (no ptrace, no
    signals, no device writes).

The real container name from the source task's artifacts
(`comfyui-ca76e727-68f6-45da-8c8b-bb46c70161bc`) is passed as --prompt-id only for
header correlation context, mirroring how the agent would invoke the tool.
"""
import json
import os
import subprocess
import sys
import time

WORKTREE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MONITOR = os.path.join(WORKTREE, "scripts", "xpu-run-monitor.mts")
CONTAINER = "comfyui-ca76e727-68f6-45da-8c8b-bb46c70161bc"


def read_cpu_ticks(pid: int) -> int:
    with open(f"/proc/{pid}/stat") as f:
        fields = f.read().split()
    # utime (14) + stime (15), 1-indexed in proc(5); list is 0-indexed.
    return int(fields[13]) + int(fields[14])


def main() -> int:
    # Spawn a CPU burner: `yes > /dev/null` pegs one core.
    burner = subprocess.Popen(["yes"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(0.5)  # let it start burning
        ticks_before = read_cpu_ticks(burner.pid)

        proc = subprocess.run(
            ["npx", "tsx", MONITOR, "--pid", str(burner.pid),
             "--prompt-id", CONTAINER, "--interval", "1", "--samples", "3", "--json"],
            cwd=WORKTREE, capture_output=True, text=True, timeout=120,
        )
        if proc.returncode != 0:
            print("FAIL: monitor exited non-zero")
            print(proc.stderr)
            return 1

        rows = []
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "memUsedMib" in obj and "threads" in obj:
                rows.append(obj)

        if not rows:
            print("FAIL: no sample rows emitted")
            return 1

        # Item 1a: VRAM reported.
        vram = [r["memUsedMib"] for r in rows if r["memUsedMib"] is not None]
        if not vram:
            print("FAIL: memUsedMib never reported (xpu-smi unreadable on this host?)")
            return 1
        # Item 1b: threads reported.
        threads = [r["threads"] for r in rows if r["threads"] is not None]
        if not threads or threads[0] < 1:
            print("FAIL: threads not reported / zero")
            return 1
        # Item 1c: active compute detected (cpuDelta > 0 => activeCompute true).
        active = [r for r in rows if r.get("activeCompute") is True]
        if not active:
            print("FAIL: no sample showed increasing CPU time (activeCompute)")
            return 1

        # Item 2: non-interference -- burner still alive and still burning after.
        if burner.poll() is not None:
            print("FAIL: burner process died during/after monitoring")
            return 1
        time.sleep(0.5)
        ticks_after = read_cpu_ticks(burner.pid)
        if ticks_after <= ticks_before:
            print("FAIL: burner CPU time did not increase after monitoring (interfered?)")
            return 1

        print("PASS: monitor reported VRAM (memUsedMib=%s) and %d thread(s); "
              "activeCompute detected in %d/%d sample(s); burner survived and kept "
              "burning (ticks %d -> %d) -- non-invasive." % (
                  vram[-1], threads[0], len(active), len(rows), ticks_before, ticks_after))
        return 0
    finally:
        if burner.poll() is None:
            burner.kill()
            burner.wait()


if __name__ == "__main__":
    sys.exit(main())
