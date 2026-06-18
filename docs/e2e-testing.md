# E2E Testing Guide

## Overview

The E2E test (`tests/qwen-full-gui-verification.spec.ts`) runs the complete migration pipeline against a real LLM provider with the Qwen-Image-2512 workflow. Expected duration: 1-4 hours for a fresh run, ~2 minutes when reusing a completed Phase 1 task.

## Prerequisites

### Environment

- Node.js 22+ with npm
- Playwright browsers: `npx playwright install chromium`
- ComfyUI fork with XPU venv at `$COMFYUI_ROOT/.venv-xpu`
- `env` file configured with LLM provider credentials (see `env.example`)

### Files

- Source workflow JSON (Qwen-Image-2512 single-reference workflow)
- Fox reference image (>100KB — NOT the black `z-image_00006_.png`)
- All models staged in `MODEL_ROOTS` directories

### Services

```bash
# Start migration agent backend + frontend
cd agent-demo && bash scripts/restart.sh

# Verify
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:5173
```

ComfyUI is launched automatically by the pipeline (Step 05). No manual start needed.

## How to run

### Quick start

```bash
npm run test:e2e:qwen
```

### With custom paths

```bash
export E2E_API_URL=http://127.0.0.1:3001
export E2E_FRONTEND_URL=http://127.0.0.1:5173
export E2E_WORKFLOW_PATH=/path/to/workflow.json
export E2E_REFERENCE_IMAGE=/path/to/fox_512x512.png

npm run test:e2e:qwen
```

### Background execution (long runs)

```bash
nohup npm run test:e2e:qwen > /tmp/e2e-test.log 2>&1 &
tail -f /tmp/e2e-test.log
```

## Test structure

| # | Test | Duration | What it verifies |
|---|------|----------|-----------------|
| 00 | cleanup and create task | ~30s | Creates task; reuses existing if Phase 1 done |
| 01 | upload fox reference image | ~10s | Uploads reference image under both filenames aliases |
| 02 | run Phase 1 pipeline | 1-4hr | Steps 00-11 with automated gate handling |
| 03 | verify Phase 1 artifacts | ~30s | Key artifacts exist (intake, asset, feasibility, etc.) |
| 04 | verify key XPU modification points | ~60s | Runtime patches: CLIP cpu, txt2img, venv launch |
| 05 | run Step 12 GUI acceptance | up to 4hr | Interactive GUI acceptance with auto-gate-handling |
| 06 | verify final delivery package | ~60s | Delivery artifacts, fix-log, output images |
| 07 | frontend displays completed pipeline | ~30s | Frontend renders task, pipeline, artifacts tab |
| 08 | generate and verify run report | ~10s | Run report generation |
| 09 | cleanup | ~5s | Cleans stale tasks, preserves main task |

## Task reuse for faster re-runs

Test 00 checks for an existing task with Step 11 completed. If found, Phase 1 (test 02) is skipped entirely.

To force a fresh run:

```bash
curl -X POST http://127.0.0.1:3001/api/tasks/cleanup-stale
```

## Gate-handling mechanism

### Deterministic gates (multiple choice)

Steps 01, 02, 05, etc. offer specific choices. The test picks the most permissive "continue/proceed/skip" option using `CHOICE_PREFERENCE` keyword matching.

### Freeform gates (text response)

Step 12 and some LLM-generated gates expect freeform text. The test uses `PREVIOUS_FEEDBACK_DECISIONS[stepId]` encoding validated workarounds from prior runs.

### Multi-gate sequences

Steps like 02 ask 5-7 sequential questions. `handleGate` loops through them: answer each, wait 15s, check for new questions.

## Troubleshooting

### Step stuck in gate loop

Check that `CHOICE_PREFERENCE` keywords match the actual choice text. Update keywords if the agent changed gate wording.

### HTTP 401 from LLM provider

- Verify `COPILOT_PROVIDER_API_KEY` in the `env` file
- Restart the server: `bash scripts/restart.sh`
- For DeepSeek: use `COPILOT_PROVIDER_TYPE=openai` with `COPILOT_PROVIDER_BASE_URL=https://api.deepseek.com`

### ComfyUI crashes during Step 07/08

The orchestrator auto-restarts ComfyUI. If it crashes repeatedly:
- Check for segfaults (common with XPU + GGUF)
- Ensure CLIP `device=cpu` workaround is in the runtime patch bundle
- Verify venv launch pattern (`source activate && python3`, not direct path)

### Frontend test timeout (test 07)

Ensure the frontend dev server is running and `baseURL` in `playwright.config.ts` matches your environment. The test uses a 30-second `waitForSelector` timeout.

### Server lock error

Restart the server to clear the in-memory lock:
```bash
bash scripts/restart.sh
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `E2E_API_URL` | `http://127.0.0.1:3001` | Migration agent API URL |
| `E2E_FRONTEND_URL` | `http://127.0.0.1:5173` | Frontend dev server URL |
| `E2E_WORKFLOW_PATH` | `../../../cartoon/Qwen-Image-...json` | Source workflow JSON path |
| `E2E_REFERENCE_IMAGE` | `/home/intel/hf_models/.../fox_512x512.png` | Reference input image path |
