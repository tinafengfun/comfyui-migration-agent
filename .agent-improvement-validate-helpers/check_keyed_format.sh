#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTIFACTS_DIR="/home/intel/tianfeng/comfy/ComfyUI/agent-demo/workspaces/19ddae81-22d5-4c23-a06c-a3fe07c3479c/artifacts"

# Wrap flat-dict history in prompt_id-keyed format
python3 -c "
import json
d = json.load(open('$ARTIFACTS_DIR/08-full-validation/08-full-run-history.json'))
wrapper = {d['prompt'][1]: d}
json.dump(wrapper, open('/tmp/test-keyed-wrapper.json', 'w'))
"

# Run tool with keyed format
python3 "$WORKTREE/prompts/migration-workflow-v2/tools/step10_coverage_reconcile.py" \
    --inventory "$ARTIFACTS_DIR/03-inventory.md" \
    --full-history /tmp/test-keyed-wrapper.json \
    --smoke-histories \
        "$ARTIFACTS_DIR/07-branch-smokes/node-72/07-node-72-smoke-history.json" \
        "$ARTIFACTS_DIR/07-branch-smokes/node-68/07-node-68-smoke-history.json" \
    --output-dir /tmp/validate-keyed

# Compare keyed output with flat-dict output
python3 -c "
import csv
krows = {r['node_id']: r['coverage_status'] for r in csv.DictReader(open('/tmp/validate-keyed/10-node-coverage.csv'))}
frows = {r['node_id']: r['coverage_status'] for r in csv.DictReader(open('/tmp/validate-coverage/10-node-coverage.csv'))}
match = all(krows.get(k) == frows.get(k) for k in krows)
print(f'prompt_id-keyed matches flat-dict: {match}')
assert match, 'Mismatch between prompt_id-keyed and flat-dict formats'
print('PASS')
"
