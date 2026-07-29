#!/usr/bin/env python3
"""
S13-05 validation — confirm the normal restart paths are unaffected.

Two checks:

  (a) Bare-runtime node: `restart` must take the existing detached-launch path
      (print "launched; waiting up to") and must NOT invoke any docker fallback
      ("falling back to docker restart" / "docker exec" absent).

  (b) Docker-runtime node where the in-container kill SUCCEEDS (PID 1 actually
      dies): the tool must `docker start` the stopped container (print
      "container stopped after kill; docker start") and must NOT print the
      hung-PID-1 fallback message.

Diagnostics go to /tmp/s13-05-normal.log; only a one-line verdict is printed.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

WORKTREE = Path(__file__).resolve().parents[2]
IMAGE = "alpine:3.20"
CONTAINER = f"comfyui-s1305-normal-{os.getpid()}"
PORT = 18189
LOG = "/tmp/s13-05-normal.log"


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def log(msg):
    with open(LOG, "a") as f:
        f.write(msg + "\n")


def write_nodes(nodes):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(nodes, f)
    f.close()
    return f.name


def cleanup():
    sh(["docker", "rm", "-f", CONTAINER], timeout=30)
    for p in (f"/tmp/start-comfyui-{PORT}.sh", f"/tmp/start-comfyui-{PORT}.out", "/tmp/cma-s1305-main.py"):
        try:
            if os.path.isdir(p):
                shutil.rmtree(p)
            else:
                os.unlink(p)
        except FileNotFoundError:
            pass


def check_bare():
    nodes = {
        "default_node": "barenode",
        "nodes": [{
            "name": "barenode", "kind": "local", "runtime": "bare",
            "comfyui_root": "/tmp/cma-s1305-noexist", "venv_python": "/bin/false",
            "model_roots": [], "api_host": "127.0.0.1", "api_port": PORT,
        }],
    }
    nodes_path = write_nodes(nodes)
    env = dict(os.environ, GPU_NODES_PATH=nodes_path)
    try:
        r = sh(
            ["npx", "--yes", "tsx", "scripts/remote-comfyui.mts",
             "--node", "barenode", "--action", "restart",
             "--api-url", "http://127.0.0.1:65531", "--wait", "2"],
            cwd=WORKTREE, env=env, timeout=120,
        )
        out = r.stdout + r.stderr
        log("[bare] tool output:\n" + out)
        ok = True
        reason = ""
        if "launched; waiting up to" not in out:
            ok = False; reason = "normal launch path not taken"
        if "falling back to docker restart" in out or "docker exec" in out:
            ok = False; reason = (reason + "; " if reason else "") + "docker path should not be invoked for bare runtime"
        return ok, reason
    finally:
        os.unlink(nodes_path)
        cleanup()


def check_docker_kill_succeeds():
    if sh(["docker", "info"]).returncode != 0:
        log("docker daemon not available — SKIP docker sub-check")
        return True, ""
    cleanup()
    nodes_path = None
    try:
        # PID 1 = `sh /main.py`; traps SIGTERM and exits 0, so the in-container
        # `pkill -f main.py` actually kills PID 1 -> container stops -> tool must
        # `docker start` it (NOT docker restart). Host file MUST exist before -v.
        script = "#!/bin/sh\ntrap 'exit 0' TERM\nwhile true; do sleep 1; done\n"
        with open("/tmp/cma-s1305-main.py", "w") as f:
            f.write(script)
        r = sh(["docker", "run", "-d", "--name", CONTAINER,
                "-v", "/tmp/cma-s1305-main.py:/main.py:ro",
                IMAGE, "sh", "/main.py"], timeout=60)
        if r.returncode != 0:
            log("docker run failed: " + r.stderr)
            return False, "docker run failed"
        for _ in range(20):
            if sh(["docker", "inspect", "-f", "{{.State.Status}}", CONTAINER], timeout=15).stdout.strip() == "running":
                break
            time.sleep(0.5)

        nodes = {
            "default_node": "dn",
            "nodes": [{
                "name": "dn", "kind": "local", "runtime": "docker",
                "docker_image": IMAGE, "comfyui_root": "/tmp/cma-s1305-noexist",
                "venv_python": "/bin/false", "model_roots": [],
                "api_host": "127.0.0.1", "api_port": PORT,
            }],
        }
        nodes_path = write_nodes(nodes)
        env = dict(os.environ, GPU_NODES_PATH=nodes_path)
        r = sh(
            ["npx", "--yes", "tsx", "scripts/remote-comfyui.mts",
             "--node", "dn", "--action", "restart",
             "--container", CONTAINER,
             "--api-url", "http://127.0.0.1:65532", "--wait", "2"],
            cwd=WORKTREE, env=env, timeout=120,
        )
        out = r.stdout + r.stderr
        log("[docker-kill-ok] tool output:\n" + out)
        ok = True
        reason = ""
        if "container stopped after kill; docker start" not in out:
            ok = False; reason = "docker start branch not taken"
        if "falling back to docker restart" in out:
            ok = False; reason = (reason + "; " if reason else "") + "should NOT have hit the hung-PID-1 fallback"
        return ok, reason
    finally:
        if nodes_path:
            os.unlink(nodes_path)
        cleanup()


def main():
    open(LOG, "w").close()
    a, ra = check_bare()
    log(f"bare check: ok={a} reason={ra}")
    b, rb = check_docker_kill_succeeds()
    log(f"docker-kill-ok check: ok={b} reason={rb}")
    ok = a and b
    reason = " ; ".join(x for x in (ra, rb) if x)
    verdict = "PASS" if ok else f"FAIL: {reason}"
    print(f"S13-05 normal-restart path: {verdict}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
