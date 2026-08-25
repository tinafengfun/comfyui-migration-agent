#!/usr/bin/env python3
"""Stage 0 — parse the `custom_node_list` tab of comfyui_migration_tasks.xlsx into a
normalized nodes.json for the catalog import pipeline.

Per row: name, repository, nodeKey (mirrors src/catalog/schema.ts nodeKeyFromRepo),
needs_patch, in_omni_b7, notes, and a PROVISIONAL bucket:
  A = bind (pure-python / cuda->xpu-patch) — the default majority
  B = sycl  (needs a compiled native XPU extension — confirmed in Stage 2)
  C = unsupported (full-CUDA / "暂不移植") — recorded but not cloned

Pure/deterministic; stdlib + openpyxl only. Run:
  python3 scripts/catalog-import/parse-xlsx.py [xlsx] [-o out.json] [--pilot]
"""
import argparse, json, re, sys

DEFAULT_XLSX = "/home/intel/tianfeng/comfy/comfyui_migration_tasks.xlsx"
TAB = "custom_node_list"

# Well-known repos for the handful of rows that have a name but no URL cell.
# Marked url_source="inferred" so they're distinguishable/auditable.
INFERRED_URLS = {
    "ComfyUI-Inpaint-CropAndStitch": "https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch",
    "ComfyUI-MultiGPU": "https://github.com/pollockjj/ComfyUI-MultiGPU",
    "ComfyUI-Advanced-ControlNet": "https://github.com/Kosinkadink/ComfyUI-Advanced-ControlNet",
    "ComfyUI-TeaCache": "https://github.com/welltop-cn/ComfyUI-TeaCache",
    "comfyui-mixlab-nodes": "https://github.com/shadowcz007/comfyui-mixlab-nodes",
    "tinyterraNodes": "https://github.com/TinyTerra/ComfyUI_tinyterraNodes",
}

# Provisional SYCL (bucket B) — packages whose XPU support needs a compiled native
# extension. Kept deliberately narrow (the clear compiled-wheel case); Stage 2 is
# authoritative — it promotes any node with a real native build step to B.
SYCL_HINTS = ("llama-cpp", "llama_cpp")
# Full-CUDA / no-SYCL-path → bucket C (recorded unsupported, not cloned).
UNSUPPORTED_HINTS = ("暂不移植", "完全是cuda", "完全是 cuda", "nunchaku", "flashvsr")


def node_key_from_repo(repo: str) -> str:
    """Mirror src/catalog/schema.ts nodeKeyFromRepo → '<owner>__<repo>' lowercased."""
    s = (repo or "").strip()
    s = re.sub(r"\.git$", "", s)
    s = s.rstrip("/")
    m = re.search(r"github\.com[:/]+([^/]+)/([^/]+)$", s, re.I)
    if m:
        owner, name = m.group(1), m.group(2)
    else:
        m2 = re.search(r"[:/]([^/]+)/([^/]+)$", s)
        if m2:
            owner, name = m2.group(1), m2.group(2)
        else:
            name = s.split("/")[-1] or s
            owner = name
    slug = lambda x: re.sub(r"[^a-z0-9._-]", "-", x.lower())
    return f"{slug(owner)}__{slug(name)}"


def package_name_from_repo(repo: str) -> str:
    s = re.sub(r"\.git$", "", (repo or "").strip()).rstrip("/")
    return s.split("/")[-1] or s


def norm(x):
    return str(x).strip() if x is not None else ""


def truthy(x):
    return norm(x).lower() in ("yes", "y", "true", "是", "1")


def classify(name, repo, notes, needs_patch):
    blob = (name + " " + notes).lower()
    if any(h in blob for h in UNSUPPORTED_HINTS):
        return "C", "notes say full-CUDA / 暂不移植"
    if any(h in blob for h in SYCL_HINTS):
        return "B", "provisional: hints a compiled native/SYCL extension"
    return "A", "bind (pure-python or cuda->xpu patch)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx", nargs="?", default=DEFAULT_XLSX)
    ap.add_argument("-o", "--out", default="/tmp/catalog-import-nodes.json")
    ap.add_argument("--pilot", action="store_true", help="emit only a small mixed pilot subset")
    ap.add_argument("--all", action="store_true", help="emit the full list (default; accepted for symmetry)")
    args = ap.parse_args()

    import openpyxl
    wb = openpyxl.load_workbook(args.xlsx, read_only=True, data_only=True)
    rows = list(wb[TAB].iter_rows(values_only=True))[1:]

    out, seen, skipped = [], {}, []
    for r in rows:
        name = norm(r[0])
        if not name:
            continue
        # section-header rows like "Custom nodes 下载量41-60"
        if re.match(r"^Custom nodes\b", name, re.I):
            continue
        url = norm(r[2])
        url_source = "sheet"
        if not url.startswith("http"):
            if name in INFERRED_URLS:
                url, url_source = INFERRED_URLS[name], "inferred"
            else:
                skipped.append({"name": name, "reason": "no url"})
                continue
        if "github.com" not in url:  # e.g. the 1 comfy-registry URL
            skipped.append({"name": name, "reason": f"non-github url: {url}"})
            continue

        key = node_key_from_repo(url)
        notes = norm(r[3]) + (" | " + norm(r[4]) if norm(r[4]) else "")
        needs_patch = truthy(r[6])
        in_omni_b7 = truthy(r[7])
        bucket, reason = classify(name, url, notes, needs_patch)

        rec = {
            "name": name,
            "package_name": package_name_from_repo(url),
            "repository": url,
            "url_source": url_source,
            "node_key": key,
            "needs_patch": needs_patch,
            "in_omni_b7": in_omni_b7,
            "downloads": norm(r[1]),
            "notes": notes,
            "attribution": norm(r[9]) if len(r) > 9 else "",
            "bucket": bucket,
            "bucket_reason": reason,
        }
        if key in seen:  # dedup — keep the richer row
            if len(notes) > len(seen[key]["notes"]):
                out[seen[key]["_i"]] = {**rec, "_i": seen[key]["_i"]}
            continue
        rec["_i"] = len(out)
        seen[key] = rec
        out.append(rec)

    for rec in out:
        rec.pop("_i", None)

    if args.pilot:
        # Small mixed subset that EXERCISES the full chain: prefer NOT-in-omni-b7 nodes
        # (so clone/install/patch actually run), spanning bind / cuda->xpu-patch / SYCL,
        # plus one in-omni-b7 node to cover that path too.
        fresh = [r for r in out if not r["in_omni_b7"]]
        A = [r for r in fresh if r["bucket"] == "A" and not r["needs_patch"]][:3]
        P = [r for r in fresh if r["bucket"] == "A" and r["needs_patch"]][:2]
        B = [r for r in fresh if r["bucket"] == "B"][:1]
        inb7 = [r for r in out if r["in_omni_b7"] and r["bucket"] == "A"][:1]
        out = A + P + B + inb7

    from collections import Counter
    bc = Counter(r["bucket"] for r in out)
    json.dump(out, open(args.out, "w"), ensure_ascii=False, indent=2)
    print(f"wrote {len(out)} nodes -> {args.out}")
    print(f"  buckets: {dict(bc)}  (A=bind B=sycl C=unsupported)")
    print(f"  needs_patch: {sum(1 for r in out if r['needs_patch'])}  in_omni_b7: {sum(1 for r in out if r['in_omni_b7'])}")
    print(f"  inferred-url: {sum(1 for r in out if r['url_source']=='inferred')}")
    print(f"  skipped rows: {len(skipped)}" + (f" -> {skipped}" if skipped else ""))


if __name__ == "__main__":
    main()
