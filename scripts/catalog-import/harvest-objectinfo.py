#!/usr/bin/env python3
"""Stage 3 — the "simple XPU check": launch ONE omni-b7 XPU container with the batch's
custom nodes, GET /object_info, and via each class_type's `python_module` attribute the
class_types back to their package. Yields, per package:
  - nodeTypePrefixes  (its registered class_types)
  - registered        (bool: >=1 class_type registered on XPU without import error)
This both derives the catalog `nodeTypePrefixes` AND proves XPU registration in one pass.

Isolates from production by nested-mounting a harvest-only custom_nodes dir over the
core's. Read-only w.r.t. the catalog. Requires docker + the omni-b7 image.

Usage:
  harvest-objectinfo.py <nodes.json> [--clone-state clone-state.json]
     [--image intel/llm-scaler-omni:0.1.0-b7] [--comfy-core /nfs_share/comfyui-core]
     [--nfs-root /nfs_share] [--port 8199] [--out harvest.json] [--timeout 240]
"""
import argparse, json, os, re, shutil, subprocess, sys, time, urllib.request

def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)

def render_gids():
    out = sh(["bash", "-c", "stat -c '%g' /dev/dri/render* 2>/dev/null | sort -u"]).stdout
    return [g for g in out.split() if g]

def http_json(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("nodes_json")
    ap.add_argument("--clone-state", default="/tmp/catalog-import-clone-state.json")
    ap.add_argument("--image", default="intel/llm-scaler-omni:0.1.0-b7")
    ap.add_argument("--comfy-core", default="/nfs_share/comfyui-core")
    ap.add_argument("--nfs-root", default="/nfs_share")
    ap.add_argument("--port", type=int, default=8199)
    ap.add_argument("--out", default="/tmp/catalog-import-harvest.json")
    ap.add_argument("--timeout", type=int, default=240)
    ap.add_argument("--batch-size", type=int, default=25, help="nodes per container (0=all in one)")
    ap.add_argument("--keep", action="store_true", help="don't tear down the container")
    a = ap.parse_args()

    nodes = json.load(open(a.nodes_json))
    clone = json.load(open(a.clone_state)) if os.path.exists(a.clone_state) else {}
    # bucket A/B nodes that actually cloned (bucket B is tested here too via the bind
    # path; its compiled wheel is validated separately in the SYCL image build).
    pkgs = [r["package_name"] for r in nodes
            if r["bucket"] in ("A", "B") and clone.get(r["package_name"], {}).get("cloned", os.path.isdir(f"{a.nfs_root}/custom_nodes/{r['package_name']}"))]
    if not pkgs:
        print("no cloned bucket-A/B packages to harvest"); sys.exit(1)

    pkgs = sorted(set(pkgs))  # dedup: the sheet can list a package under >1 row
    gid_flags = []
    for g in render_gids():
        gid_flags += ["--group-add", g]

    def harvest_batch(batch, port):
        """Run one container over `batch` packages; return {pkg: {class_types, registered, timeout}}."""
        hdir = f"{a.nfs_root}/catalog-import/harvest-custom-nodes"
        shutil.rmtree(hdir, ignore_errors=True); os.makedirs(hdir)
        for p in batch:
            src = f"{a.nfs_root}/custom_nodes/{p}"
            dst = os.path.join(hdir, p)
            if os.path.isdir(src) and not os.path.lexists(dst):
                os.symlink(src, dst)
        name = "catalog-harvest"
        sh(["docker", "rm", "-f", name])
        cmd = ["docker", "run", "-d", "--name", name, "--network", "host", "--device", "/dev/dri",
               *gid_flags, "-e", "ZE_AFFINITY_MASK=0", "-e", "OMNI_FP8_KEEP_ON_MOVE=1",
               "-e", "NO_PROXY", "-e", "no_proxy", "-e", "HTTP_PROXY", "-e", "HTTPS_PROXY",
               "-e", "http_proxy", "-e", "https_proxy",
               "-v", f"{a.nfs_root}:{a.nfs_root}", "-v", f"{a.comfy_core}:/comfyui",
               "-v", f"{hdir}:/comfyui/custom_nodes",
               "--entrypoint", f"{a.nfs_root}/venv-container-xpu/bin/python3", a.image,
               "/comfyui/main.py", "--port", str(port), "--listen", "127.0.0.1"]
        r = sh(cmd)
        if r.returncode != 0:
            print("  docker run failed:", r.stderr[:200])
            return {p: {"class_types": [], "registered": False, "timeout": True} for p in batch}
        obj, deadline, url = None, time.time() + a.timeout, f"http://127.0.0.1:{port}/object_info"
        while time.time() < deadline:
            try:
                obj = http_json(url, timeout=8)
                if obj: break
            except Exception:
                pass
            time.sleep(4)
        if not obj:
            print("  batch object_info never came up (timeout) — nodes flagged not-registered")
            if not a.keep: sh(["docker", "rm", "-f", name])
            return {p: {"class_types": [], "registered": False, "timeout": True} for p in batch}
        reg = {p: set() for p in batch}
        for ct, meta in obj.items():
            pm = (meta or {}).get("python_module", "") if isinstance(meta, dict) else ""
            m = re.match(r"custom_nodes\.([^.]+)", pm or "")
            if m and m.group(1) in reg:
                reg[m.group(1)].add(ct)
        if not a.keep: sh(["docker", "rm", "-f", name])
        return {p: {"class_types": sorted(reg[p]), "registered": len(reg[p]) > 0, "timeout": False} for p in batch}

    bs = a.batch_size if a.batch_size > 0 else len(pkgs)
    batches = [pkgs[i:i + bs] for i in range(0, len(pkgs), bs)]
    result = {}
    for bi, batch in enumerate(batches):
        print(f"[batch {bi+1}/{len(batches)}] {len(batch)} packages on :{a.port} …")
        result.update(harvest_batch(batch, a.port))
        json.dump(result, open(a.out, "w"), indent=2)  # checkpoint after each batch
        ok = sum(1 for p in batch if result[p]["registered"])
        print(f"  -> {ok}/{len(batch)} registered")

    okp = [p for p in pkgs if result[p]["registered"]]
    badp = [p for p in pkgs if not result[p]["registered"]]
    print(f"\nHARVEST: {len(okp)}/{len(pkgs)} packages registered on XPU -> {a.out}")
    print(f"  failed ({len(badp)}): {', '.join(badp)}")

if __name__ == "__main__":
    main()
