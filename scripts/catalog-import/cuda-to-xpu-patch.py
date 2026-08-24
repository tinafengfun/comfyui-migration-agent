#!/usr/bin/env python3
"""Stage 2 helper — auto-apply the simple cuda->xpu device conversion to a cloned
custom-node's Python source (the `needs_patch` case is confirmed to be plain device
references, per the sheet). Conservative: only rewrites clear device references, not
arbitrary "cuda" strings. Idempotent (re-derives from a one-time .orig backup) and
emits a unified diff artifact recorded on the catalog record.

Usage:
  cuda-to-xpu-patch.py <node-dir> [--diff-out patch.diff] [--check]   # --check = self-test
"""
import argparse, difflib, os, re, sys

# (pattern, replacement) — device references only.
SUBS = [
    (re.compile(r"\btorch\.cuda\.is_available\b"), "torch.xpu.is_available"),
    (re.compile(r"\btorch\.cuda\.empty_cache\b"), "torch.xpu.empty_cache"),
    (re.compile(r"\btorch\.cuda\.current_device\b"), "torch.xpu.current_device"),
    (re.compile(r"\btorch\.cuda\.device_count\b"), "torch.xpu.device_count"),
    (re.compile(r"\btorch\.cuda\.synchronize\b"), "torch.xpu.synchronize"),
    (re.compile(r"\btorch\.cuda\.get_device_properties\b"), "torch.xpu.get_device_properties"),
    (re.compile(r"\btorch\.cuda\.memory_allocated\b"), "torch.xpu.memory_allocated"),
    (re.compile(r"\btorch\.cuda\.mem_get_info\b"), "torch.xpu.mem_get_info"),
    (re.compile(r"\btorch\.cuda\.max_memory_allocated\b"), "torch.xpu.max_memory_allocated"),
    (re.compile(r"\btorch\.cuda\.reset_peak_memory_stats\b"), "torch.xpu.reset_peak_memory_stats"),
    (re.compile(r"\btorch\.cuda\.OutOfMemoryError\b"), "torch.xpu.OutOfMemoryError"),
    # device strings: .to("cuda"|"cuda:N"), device="cuda"|"cuda:N"
    (re.compile(r"""(\.to\(\s*['"])cuda(?::\d+)?(['"])"""), r"\1xpu\2"),
    (re.compile(r"""(device\s*=\s*['"])cuda(?::\d+)?(['"])"""), r"\1xpu\2"),
    (re.compile(r"""(['"])cuda:\d+(['"])"""), r"\1xpu\2"),  # bare "cuda:0" device literals
    # .cuda()  ->  .to("xpu")
    (re.compile(r"\.cuda\(\s*\)"), '.to("xpu")'),
]

SKIP_DIRS = {".git", "__pycache__", "web", "js", "node_modules", ".github"}


def convert_text(text: str):
    n = 0
    for pat, rep in SUBS:
        text, c = pat.subn(rep, text)
        n += c
    return text, n


def patch_dir(node_dir: str, diff_out: str | None):
    diffs, total, files = [], 0, 0
    for root, dirs, names in os.walk(node_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in names:
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name)
            orig_path = path + ".orig"
            # idempotent: source of truth is the one-time .orig backup if it exists
            base = open(orig_path, encoding="utf-8", errors="ignore").read() if os.path.exists(orig_path) \
                else open(path, encoding="utf-8", errors="ignore").read()
            new, n = convert_text(base)
            if n == 0:
                continue
            if not os.path.exists(orig_path):
                open(orig_path, "w", encoding="utf-8").write(base)  # back up original once
            open(path, "w", encoding="utf-8").write(new)
            rel = os.path.relpath(path, node_dir)
            diffs += list(difflib.unified_diff(base.splitlines(True), new.splitlines(True),
                                               f"a/{rel}", f"b/{rel}"))
            total += n
            files += 1
    if diff_out and diffs:
        open(diff_out, "w", encoding="utf-8").writelines(diffs)
    return {"files_changed": files, "substitutions": total, "diff": diff_out if diffs else None}


def self_test():
    cases = [
        ('x = t.to("cuda")', 'x = t.to("xpu")'),
        ("x = t.to('cuda:0')", "x = t.to('xpu')"),
        ('m = model.cuda()', 'm = model.to("xpu")'),
        ('d = torch.device("cuda:1")', 'd = torch.device("xpu")'),
        ('if torch.cuda.is_available():', 'if torch.xpu.is_available():'),
        ('torch.cuda.empty_cache()', 'torch.xpu.empty_cache()'),
        ('device = "cuda"', 'device = "xpu"'),
        ('name = "cuda_kernel.cu"', 'name = "cuda_kernel.cu"'),   # NOT a device string → untouched
        ('note = "use cuda for speed"', 'note = "use cuda for speed"'),  # prose → untouched
    ]
    ok = True
    for src, want in cases:
        got, _ = convert_text(src)
        flag = "ok " if got == want else "FAIL"
        if got != want:
            ok = False
        print(f"  {flag} {src!r} -> {got!r}" + ("" if got == want else f"   (want {want!r})"))
    # idempotency
    once, _ = convert_text('t.to("cuda"); m.cuda(); torch.cuda.empty_cache()')
    twice, _ = convert_text(once)
    print(f"  {'ok ' if once == twice else 'FAIL'} idempotent")
    ok = ok and once == twice
    print("SELF-TEST:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("node_dir", nargs="?")
    ap.add_argument("--diff-out")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.check:
        sys.exit(self_test())
    if not args.node_dir:
        ap.error("node_dir required (or --check)")
    res = patch_dir(args.node_dir, args.diff_out)
    print(f"cuda->xpu: {res['files_changed']} files, {res['substitutions']} subs" +
          (f", diff={res['diff']}" if res["diff"] else " (no changes)"))


if __name__ == "__main__":
    main()
