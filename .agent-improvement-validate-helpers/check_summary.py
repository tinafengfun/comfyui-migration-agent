#!/usr/bin/env python3
"""Validate coverage summary JSON output."""
import json

new = json.load(open('/tmp/validate-coverage/10-coverage-summary.json'))
print(f'Node count: {new["source_node_count"]}')
print(f'Uncovered: {new["uncovered_executable_node_ids"]}')
print(f'All classified: {new["all_executable_nodes_classified"]}')
print(f'Executed: {new["full_run_nodes_executed"]}')
print(f'Cached: {new["full_run_nodes_cached"]}')
print(f'Output evidence: {new["output_evidence_count"]}')
print(f'Decision: {new["completion_decision"]["status"]}')
assert new["source_node_count"] == 17, f"Expected 17, got {new['source_node_count']}"
assert new["uncovered_executable_node_ids"] == [], f"Expected [], got {new['uncovered_executable_node_ids']}"
assert new["full_run_nodes_executed"] == 15, f"Expected 15, got {new['full_run_nodes_executed']}"
assert new["full_run_nodes_cached"] == 0, f"Expected 0, got {new['full_run_nodes_cached']}"
assert new["output_evidence_count"] == 2, f"Expected 2, got {new['output_evidence_count']}"
print('PASS')
