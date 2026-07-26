#!/usr/bin/env python3
"""Compare coverage CSV against reference CSV."""
import csv, sys, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WORKTREE = os.path.normpath(os.path.join(SCRIPT_DIR, ".."))

new_path = "/tmp/validate-coverage/10-node-coverage.csv"
ref_path = "/home/intel/tianfeng/comfy/ComfyUI/agent-demo/workspaces/19ddae81-22d5-4c23-a06c-a3fe07c3479c/artifacts/10-node-coverage.csv"

new_rows = list(csv.DictReader(open(new_path)))
ref_rows = list(csv.DictReader(open(ref_path)))
new_by_id = {r['node_id']: r for r in new_rows}
ref_by_id = {r['node_id']: r for r in ref_rows}
all_ids = set(new_by_id) | set(ref_by_id)
mismatches = 0
covered_ids = set()
ref_covered_ids = set()
new_excluded = set()
ref_excluded = set()
new_uncovered = set()
ref_uncovered = set()
covered_prefixes = ('covered_full_run', 'covered_smoke', 'covered_output')
excluded_prefixes = ('excluded_', 'excluded')
for nid in all_ids:
    nr = new_by_id.get(nid)
    rr = ref_by_id.get(nid)
    ncov = nr['coverage_status'] if nr else 'MISSING'
    rcov = rr['status'] if rr else 'MISSING'
    is_excluded = ncov.startswith(excluded_prefixes) or ncov == 'excluded'
    ref_is_excluded = rcov.startswith(excluded_prefixes) or rcov == 'excluded'
    is_covered = ncov.startswith(covered_prefixes)
    ref_is_covered = rcov.startswith(covered_prefixes)
    if is_covered:
        covered_ids.add(nid)
    if ref_is_covered:
        ref_covered_ids.add(nid)
    if is_excluded:
        new_excluded.add(nid)
    if ref_is_excluded:
        ref_excluded.add(nid)
    if ncov == 'uncovered_executable':
        new_uncovered.add(nid)
    if rcov == 'uncovered_executable':
        ref_uncovered.add(nid)
    if (is_covered != ref_is_covered) or (is_excluded != ref_is_excluded):
        mismatches += 1
        print(f'MISMATCH {nid}: new={ncov} ref={rcov}')
print(f'Covered: new={sorted(covered_ids)} ref={sorted(ref_covered_ids)}')
print(f'Excluded: new={sorted(new_excluded)} ref={sorted(ref_excluded)}')
print(f'Uncovered: new={sorted(new_uncovered)} ref={sorted(ref_uncovered)}')
print(f'Total mismatches: {mismatches}')
print('PASS' if mismatches == 0 else 'FAIL')
sys.exit(0 if mismatches == 0 else 1)
