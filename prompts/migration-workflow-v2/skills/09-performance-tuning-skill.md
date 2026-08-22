### CRITICAL: ask_user for ALL human communication

You MUST use the `ask_user` tool for EVERY message to the human operator. The human CANNOT see your plain text output. If you write findings, questions, or follow-ups as plain text instead of calling `ask_user`, the step will end prematurely. This includes presenting hard_stop items, gate decisions, validation failures, and any question requiring human judgment. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Performance tuning skill

## Use when

Use only after a baseline path works or a controlled failing path is defined.

## Inputs

- baseline prompt
- fixed seed/settings
- telemetry tools
- candidate knobs

## Algorithm

1. Freeze baseline and success criteria.
2. Define one-variable or named-bundle candidates.
3. Validate the harness before the expensive trials: queue submission, history capture, output discovery, telemetry parser, and cache detection must all produce usable evidence.
   - **The `/prompt` API expects a FLAT `{node_id: {class_type, inputs}}` structure, not `{prompt: {...}}`.** If `reduced-runtime-policy-prompt.json` has a nested `prompt` wrapper, unwrap it before submission.
4. Run repeatable trials with cold restarts or an explicit cache policy.
5. Compare speed, memory, stability, output integrity, cached-node counts, and telemetry validity.
6. Keep winner and rejected candidates with reasons.
7. If the winner uses more memory, keep a safer fallback configuration and state when to use each one.
8. If the validated baseline is already tight or cache-assisted, it is acceptable to select `no_runtime_change_selected` and defer full-size/cold tuning to a human-approved window.
9. `no_runtime_change_selected` is also a valid, expected outcome when the only working full-size config is impractically slow AND the bottleneck cannot be fixed by any runtime knob — i.e., the fix requires source-code changes (for example, implementing `torch.xpu.stream()` async transfers where only `torch.cuda.stream()` exists). In this case selecting no runtime change is correct, not a failed Step 09. Precedent: the Zimage v2 (LongCat video avatar lip-sync) run, where the block-swap mitigation (blocks_to_swap=24 + G2 patch) was the sole working full-size config but was dominated by synchronous CPU↔XPU transfers; no runtime knob avoided OOM while staying faster, so the report correctly selected `no_runtime_change_selected` and deferred the async-transfer fix to a source-code change. The report MUST still record the full evidence set: frozen baseline, candidate matrix (including rejected/untried candidates with reasons), measurements (wall time, memory, output integrity, cached-node counts), telemetry validity (flagging any collector that silently failed), remaining bottleneck (named, with the source-code fix that is out of scope), and the next-step (Step 10) coverage boundary. Do not use this outcome to skip evidence — it weakens the report exactly as much as a silent telemetry failure.

## Common failure signatures

- assuming more XPU placement is faster
- changing multiple knobs without a controlled bundle
- optimizing a path that is actually capacity blocked
- losing artifact evidence for failed candidates
- choosing a winner after telemetry silently failed
- comparing cached runs against cold runs
- treating a small speedup with much tighter memory as a universal improvement
- enabling model/cache residency knobs for a single-run workflow without batch/repeated-run validation
- selecting a faster candidate that is invalid because it violated no-bypass or was only a report/accounting failure before recovery
- launching new full-size tuning jobs when Step 08 explicitly limited the approved boundary to reduced full-path

## Evidence standard

Retain prompt/history/log/telemetry for baseline and each candidate.

Each candidate should record:

- launch flags and prompt changes
- wall time and node timing
- peak and average memory
- cached-node count
- output files or output history for every target
- telemetry parser/schema notes if custom tooling is used
- whether the run was cold, warm, or intentionally cache-assisted
- whether the candidate was accepted, report-recovery-valid, rejected, or human-gated
- whether no runtime change was selected and why

If telemetry is empty or malformed, fix the collector and rerun the affected candidates. Do not fill the gap with stale telemetry from another run.

## Hard stops

Stop if tuning does not improve baseline or exposes capacity/compatibility root cause.

Do not treat "no safe improvement" as a failed Step 09. It is complete when the baseline, rejected candidates, safe fallback, telemetry validity, and Step 10 boundary are all recorded.

## Output schema

`baseline`, `candidate`, `metric`, `telemetry_validity`, `cache_policy`, `result`, `winner`, `safe_fallback`, `rejected`, `remaining_bottleneck`.
