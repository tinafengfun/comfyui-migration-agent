---
name: frontend-regression
description: Run the Playwright frontend regression suite for the ComfyUI migration agent — Layer 1 fast GUI (@ui, ~10s, no LLM/GPU) and optionally Layer 2 live 双采 migration (@migration, long). Use after editing src/client or src/server, before signing off a change, or when the user asks for a UI/frontend/regression test. Reuses npm scripts + scripts/start-test-agent.sh; full detail in docs/frontend-testing.md.
---

# Frontend regression test

Two-tier Playwright suite lives in `tests/`. This skill runs it. It does **not**
re-implement the tests — it drives the existing npm scripts and interprets results.

## When to run

- After any change to `src/client/**` (frontend) or `src/server/**` (orchestrator/API).
- Before claiming a change is done / opening a PR.
- On demand: "run the frontend tests", "regression check", "is the UI still ok".

## Prerequisites (one-time)

```bash
npm ci
HTTPS_PROXY=http://proxy.ims.intel.com:911 npx playwright install chromium
```

## 1. Start a test agent on dedicated ports (current code, lock-free)

The orchestrator holds a one-run-per-process lock; always test against a fresh
throwaway agent so a leftover run doesn't block task creation (500).

```bash
bash scripts/start-test-agent.sh     # backend :3002, frontend :5174
```

It prints the exact `PW_BASE_URL` / `PW_API` to use. Requires an `env` file
(`cp env.example env`; fill `COPILOT_PROVIDER_API_KEY` + `COMFYUI_ROOT` + `MODEL_ROOTS`)
and the 双采 models/custom-nodes staged on the host for Layer 2.

> If you see `POST /api/tasks → 500 "another migration step is actively running"`,
> a held lock is stuck — restart the test agent.

## 2. Layer 1 — fast GUI regression (always run this)

~10 s, deterministic, no LLM/GPU. Covers the whole GUI incl. all 14 step nodes.

```bash
PW_BASE_URL=http://<ip>:5174 PW_API=http://127.0.0.1:3002 npm run playwright:ui
```

**Pass = all `@ui` cases green.** This is the gate that should always be green.
If a case fails, read the failure — it usually points at a real frontend regression
(selector changed, panel not rendering, API contract shifted).

## 3. Layer 2 — live 双采 migration (on demand; long, GPU)

Drives the real migration (DeepSeek + ComfyUI on XPU) to the final step, asserting
the GUI at every step + auto-answering gates with the historical answers.

```bash
# launch depth: → Step 05 (ComfyUI on XPU), ~30 min
PW_BASE_URL=http://<ip>:5174 PW_API=http://127.0.0.1:3002 MIGRATION_DEPTH=launch npm run playwright:migration

# full depth: → final step (real image gen), hours
PW_BASE_URL=http://<ip>:5174 PW_API=http://127.0.0.1:3002 MIGRATION_DEPTH=full npm run playwright:migration
```

**Pass criteria** (see `tests/zimage-migration.spec.ts`):
- reached the final step / all completed → PASS
- hard_stop at a content gate (missing source image, Step 12 manual GUI sign-off) → PASS
- a real `failed` step (e.g. ComfyUI OOM/crash) → FAIL (surface as env/agent bug)

Layer 2 is long — run it in the background and poll the log:
`tail -f /tmp/layer2.log` (or whatever redirect you used). Set up a recurring
check if it'll run for hours.

## 4. Interpret + report

- Report Layer 1 result first (fast, the headline).
- For Layer 2, report the highest completed step + whether ComfyUI came up on XPU.
- If the backend crashed (health 000 / unhandled exception in its log), flag it —
  that's a real finding, not a flake.
- Reference: `docs/frontend-testing.md` (runbook, env vars, troubleshooting).

## 5. Clean up

```bash
pkill -f "PORT=3002" ; pkill -f "port 5174 --strictPort"
```

## Adding a case

Reuse `tests/helpers/api.ts` for API calls; drive the UI via the existing class
hooks (`.pipeline-node`, `.step-detail h2`, `.tab`, `.artifact-browser`,
`.gpu-node-card`, `.question-card`). Tag fast cases `@ui`, live/long cases `@migration`.
