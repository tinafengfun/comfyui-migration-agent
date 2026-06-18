# Automated E2E pipeline verification skill

## Use when

- After agent code changes (server, orchestrator, prompts, skills) to verify the full pipeline still works end-to-end
- Before tagging a release or merging to main
- When validating a new LLM provider profile against the real pipeline
- Use INSTEAD of manual Step 12 testing when you need repeatable, unattended verification

## Inputs

- Migration agent server running at `E2E_API_URL` (default `http://127.0.0.1:3001`)
- Frontend running at `E2E_FRONTEND_URL` (default `http://127.0.0.1:5173`)
- ComfyUI venv at `$COMFYUI_ROOT/.venv-xpu` with `torch.xpu.is_available()`
- Source workflow JSON (`E2E_WORKFLOW_PATH` — the Qwen-Image-2512 single-reference workflow)
- Reference input image (`E2E_REFERENCE_IMAGE` — must be >100KB; use `fox_512x512.png`, NOT the black `z-image_00006_.png`)
- All required models staged in `MODEL_ROOTS` directories
- `env` file configured with LLM provider credentials (see `env.example`)

## Algorithm

### Phase 0: Prerequisites check

1. Verify server health: `GET /api/health` returns 200
2. Verify source workflow JSON exists and parses
3. Verify reference image exists and is >100KB
4. Verify LLM provider credentials are set in the server environment

### Phase 1: Task setup

5. Check for reusable task (Step 11 completed) to skip the 1-4 hour pipeline
6. If no reusable task: cleanup stale tasks, create new task from workflow JSON
7. Upload reference image under both filenames (`fox_512x512.png` and `z-image_00006_.png`)

### Phase 2: Pipeline execution with gate handling

8. Call `run-until-gate` API
9. Poll task status every 30 seconds
10. When a step hits `waiting_for_human`:
    a. Fetch `human_question` events for that step
    b. For deterministic gates (choices provided): pick choice using `CHOICE_PREFERENCE` keywords
    c. For freeform gates: use `PREVIOUS_FEEDBACK_DECISIONS[stepId]`
    d. POST to `/human-decisions` with `{questionEventId, answer, wasFreeform}`
    e. If `resumedLiveSession` is false, call `/steps/{stepId}/resume`
    f. Loop until step transitions (multi-gate sequences)
11. Continue until all steps 00-11 are completed

### Phase 3: Artifact verification

12. Verify at least 5 artifacts exist in the task workspace
13. Check for key artifact families: 00-intake, 01-asset, 02-feasibility, 05-environment, 11-delivery
14. Check runtime patch bundle for known XPU workarounds:
    - CLIP `device=cpu` (prevents XPU segfault with GGUF models)
    - `EmptySD3LatentImage` / txt2img path (prevents near-black FP8 output)
    - `source .venv-xpu/bin/activate && python3` invocation

### Phase 4: Step 12 GUI acceptance

15. Start step 12 via `/steps/12/run`
16. Handle gates with `PREVIOUS_FEEDBACK_DECISIONS["12"]`
17. On failure: read fix-log artifacts and report (do NOT throw)

### Phase 5: Final verification

18. Check delivery package artifacts
19. Check for output images
20. Verify at least 8 of 13 steps completed
21. Frontend: verify task list, pipeline nodes, artifacts tab

## Gate-handling strategy

### Deterministic gates (choices provided)

- Use `CHOICE_PREFERENCE` per-step keyword lists to pick the best matching choice
- Always prefer "proceed"/"continue"/"approve" over "stop"
- Exact text match (`wasFreeform=false`)

### Freeform gates (no choices)

- Use `PREVIOUS_FEEDBACK_DECISIONS[stepId]` encoding validated fixes from prior migration runs
- `wasFreeform=true`

### Multi-gate sequences

- Steps like 02 and 12 may emit multiple sequential questions
- `handleGate` loops: answer latest unanswered question, wait 15s, check for new questions
- 5-minute total deadline per gate sequence

### Known workarounds

| Step | Workaround |
|------|-----------|
| 01 | Skip missing assets and continue (files are staged on disk) |
| 02 | Accept CLIP `device=cpu` and txt2img as known XPU workarounds |
| 05 | Use `source .venv-xpu/bin/activate && python3 main.py` to launch ComfyUI |
| 12 | Reference `fox_512x512.png` (NOT black `z-image_00006_.png`), apply CLIP `device=cpu` |

## Evidence standard

- Task ID and final status
- Step completion counts (completed/total)
- Artifact count and key artifact presence
- Runtime patch bundle content
- Fix-log rounds and diagnosis
- Output image count
- Frontend rendering verification

## Hard stops

- Server not reachable at `E2E_API_URL`
- Source workflow JSON missing or unparseable
- Reference image missing or <100KB
- LLM provider credentials not configured (HTTP 401)
- ComfyUI venv not found at `$COMFYUI_ROOT/.venv-xpu`

## Completion criteria

- All Phase 1 steps (00-11) completed: **REQUIRED**
- At least 8 total steps completed: **MINIMUM**
- Phase 1 artifacts present: **REQUIRED** (>=5)
- Step 12 completed or failed with fix-log: **ACCEPTABLE**
- Frontend renders task and pipeline: **REQUIRED**
- Output images generated: **SOFT**

## How to run

```bash
export E2E_API_URL=http://127.0.0.1:3001
export E2E_FRONTEND_URL=http://127.0.0.1:5173
export E2E_WORKFLOW_PATH=/path/to/Qwen-Image-2512-workflow.json
export E2E_REFERENCE_IMAGE=/path/to/fox_512x512.png

npm run test:e2e:qwen
```

Expected duration: 1-4 hours fresh, ~2 minutes with task reuse.
