#!/usr/bin/env python3
"""
S13-05 validation — reproduce the hung-PID-1 docker-restart fallback.

Spins up a throwaway container whose PID 1 the in-container `pkill -f main.py`
cannot remove (no main.py process present, so the kill is a no-op and the
container stays running — the same observable condition as a hung PID 1 that
can't be killed from inside its own namespace). Then runs
`remote-comfyui.mts --action restart --container <name>` and asserts:

  1. the tool prints the "falling back to docker restart" fallback message, and
  2. the container actually got restarted (StartedAt changed).

"API recovers" can only be fully proven with a real ComfyUI+GPU, which this
throwaway env doesn't have; the docker-restart mechanism that *enables* recovery
is what we verify here. See the final summary for the human-check note.

Diagnostics go to /tmp/s13-05-fallback.log; only a one-line verdict is printed.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

WORKTREE = Path(__file__).resolve().parents[2]
IMAGE = "alpine:3.20"
CONTAINER = f"comfyui-s1305-fallback-{os.getpid()}"
LOG = "/tmp/s13-05-fallback.log"


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def log(msg):
    with open(LOG, "a") as f:
        f.write(msg + "\n")


def cleanup():
    sh(["docker", "rm", "-f", CONTAINER], timeout=30)


def main():
    open(LOG, "w").close()
    if sh(["docker", "info"]).returncode != 0:
        print("SKIP: docker daemon not available")
        return 77

    cleanup()
    try:
        r = sh(["docker", "run", "-d", "--name", CONTAINER, IMAGE, "sleep", "3600"], timeout=60)
        if r.returncode != 0:
            log("docker run failed: " + r.stderr)
            print("FAIL: docker run")
            return 1
        for _ in range(20):
            if sh(["docker", "inspect", "-f", "{{.State.Status}}", CONTAINER], timeout=15).stdout.strip() == "running":
                break
            time.sleep(0.5)

        started_before = sh(["docker", "inspect", "-f", "{{.State.StartedAt}}", CONTAINER], timeout=15).stdout.strip()

        nodes = {
            "default_node": "testnode",
            "nodes": [{
                "name": "testnode", "kind": "local", "runtime": "docker",
                "docker_image": IMAGE, "comfyui_root": "/tmp/cma-s1305-noexist",
                "venv_python": "/bin/false", "model_roots": [],
                "api_host": "127.0.0.1", "api_port": 18188,
            }],
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(nodes, f)
            nodes_path = f.name

        env = dict(os.environ, GPU_NODES_PATH=nodes_path)
        r = sh(
            ["npx", "--yes", "tsx", "scripts/remote-comfyui.mts",
             "--node", "testnode", "--action", "restart",
             "--container", CONTAINER,
             "--api-url", "http://127.0.0.1:65530", "--wait", "3"],
            cwd=WORKTREE, env=env, timeout=120,
        )
        out = r.stdout + r.stderr
        log("tool output:\n" + out)
        os.unlink(nodes_path)

        ok = True
        reason = ""
        if "falling back to docker restart" not in out:
            ok = False; reason = "fallback message not found"
        started_after = sh(["docker", "inspect", "-f", "{{.State.StartedAt}}", CONTAINER], timeout=15).stdout.strip()
        if started_after == started_before:
            ok = False; reason = (reason + "; " if reason else "") + "container not restarted"
        else:
            log(f"container restarted: {started_before} -> {started_after}")

        verdict = "PASS" if ok else f"FAIL: {reason}"
        print(f"S13-05 docker-restart fallback: {verdict}")
        return 0 if ok else 1
    finally:
        cleanup()


if __name__ == "__main__":
    sys.exit(main())
