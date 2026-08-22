# Backlog — Step 13 high-risk follow-ups (deferred, corrected diagnoses)

Origin: the Step 13 self-improvement pass on the live WAN2.2 migration (task
`2edc9d15`) proposed 6 `high_backend_tool_behavior` items. Each was re-reviewed
against the actual source; **all six had material errors** (wrong files, invented
artifacts, "fixes" to already-correct code, or unsafe rules). Four were reworked
into code-verified fixes and implemented (see below). The two here are deferred
because they need cross-cutting design, not a targeted edit — recorded with the
CORRECTED diagnosis so a future pass doesn't repeat the original mistake.

## Status of the six

| Item | Original target | Disposition |
| --- | --- | --- |
| 13-001 | `step11_delivery_packaging.py` | Implemented (de-hardcode doc templates; the proposal's data-plumbing claims were false and dropped). |
| 13-002 | `step12b_final_delivery.py` | Parts 2+3 implemented (`1d501f2`). Part 1 (launch script) → **deferred, below**. |
| 13-003 | `step09_performance_tuning.py` | Implemented in `step08` (correct owner); tri-state preserved, over-budget guard kept. |
| 13-008 | `step06_prompt_validation.py` | Implemented as a preflight (not the proposed stdlib-only rewrite). |
| 13-009 | `step08_full_validation.py` | Implemented (aggregate merge-forward; history-parsing part was a no-op and dropped). |
| 13-022 | `taskStateLedger.ts` | **Deferred, below** — wrong file, broad Phase-2 framing. |

---

## Deferred #1 — single source of truth for the delivery launch script (from 13-002 part 1)

**Corrected diagnosis.** `step12b_final_delivery.py::render_docker_launch_script()`
hand-writes a docker launch template (hardcoded `--port 8188`, a dangling
`${VENV_PYTHON}` shell var that is never assigned, `--extra-model-paths-yaml`, a
tar-copy staging flow) that matches **none** of the authoritative launch built by
`src/server/comfyuiLifecycle.ts::buildDockerStartScript()` (bind-mount, real env
vars `OMNI_FP8_KEEP_ON_MOVE`/proxy/`ZE_AFFINITY_MASK`, `--entrypoint venv_python`,
node/capacity-specific VRAM flags via `resolveVramFlags`, `port` as a parameter).

The original proposal ("read `venv_python`/`env_vars`/`port`/`bind_mounts` from
`05-environment-summary.json`") **cannot work as filed**: `step05_environment_readiness.py`
emits none of those fields, and its CLI never even receives docker/runtime info —
the truth lives in `gpu-nodes.json` + `comfyuiLifecycle.ts`, invisible to the Python
tools. Blindly hand-writing a second bind-mount template (what the live box did)
also breaks the "self-contained snapshot, no access to the task workspace" premise
the 12b prompt/skill and deployment guide promise, and the live version additionally
hardcoded this workflow's node IDs/VRAM/output-counts into the shared doc template.

**Recommended approach (pick one, then update `12b-final-delivery-prompt.md` + skill in lockstep):**
1. **Preferred:** have the backend (`comfyuiLifecycle.buildDockerStartScript`) persist the
   EXACT launch script it used into a per-task artifact (e.g. `05-docker-launch.sh` or a
   field in `05-environment-summary.json`); `step12b` echoes it verbatim into the bundle.
   One source of truth, always matches what actually ran.
2. Alternatively, extend `step05_environment_readiness.py` to record
   `runtime/docker_image/venv_python/env_vars/port/bind_mounts/vram_flags` (mirroring
   `comfyuiLifecycle`'s env + mounts) and have `step12b` render from those — but this
   duplicates the launch logic and must be kept in sync.

Do NOT ship a third divergent hand-written template. Preserve the self-contained-redeploy
semantics (or explicitly change the prompt/skill/guide if moving to bind-mount).

## Deferred #2 — in-container XPU telemetry (from 13-022)

**Corrected diagnosis.** The named file `src/server/taskStateLedger.ts` is the
deterministic writer for `task-state.json` (`steps`, `human_decisions`,
`backend_faults`) and has **zero** connection to telemetry — wrong target entirely.

The underlying observation is only partly valid: `xpu-smi` telemetry is sampled by
`src/server/gpuNodes.ts::sampleXpuMemory` (~L642-662), which deliberately runs the
sampler **on the host node** via `runShellOnNode` (xpu-smi is a host tool reading
`/dev/dri`). A `docker exec`/`dockerOnNode` wrapper pattern already exists in
`gpuNodes.ts` (~L773-777), so the "add a backend mechanism to exec inside the
container" framing is partly already met and the proposal appears unaware of it.

**Recommended approach (only if the gap is confirmed real):**
- First confirm the failing context: `sampleXpuMemory` runs host-side; error 39
  (Level Zero init) appears when telemetry is attempted from an agent shell inside a
  container lacking `/dev/dri`. If that is the real failing path, the minimal fix is to
  route the sampler through `docker exec`/`dockerOnNode` for `runtime="docker"` nodes in
  `gpuNodes.ts` (+ `scripts/xpu-mem-sample.py`) — NOT a new supervisor and NOT a new
  `/telemetry` endpoint baked into the ComfyUI container image (that lives outside this repo).
- Note: this is only cosmetic for validation correctness now that `step08`/`step09`
  degrade gracefully when telemetry is unavailable (see the 13-003 fix) — telemetry
  drives efficiency reporting, not the pass/fail gate. Low priority.
