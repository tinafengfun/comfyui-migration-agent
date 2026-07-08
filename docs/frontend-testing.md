# Frontend Playwright tests — operation guide

Two-tier Playwright suite for catching frontend regressions after system changes.

| Tier | Tag | What | LLM/GPU | Time | Command |
|---|---|---|---|---|---|
| **Layer 1** | `@ui` | Whole-frontend GUI: upload, **all 14 step nodes** + their detail panels, tabs, artifact browser, GPU-node manager, API contracts | none | ~10 s | `npm run playwright:ui` |
| **Layer 2** | `@migration` | Live **双采 workflow** migration driven to the final step, asserting the GUI at every step transition + at each gate | DeepSeek + ComfyUI XPU | ~30 min (launch) / hours (full) | `npm run playwright:migration` |

Business case for Layer 2: `tests/fixtures/zimage-shuangcai.json` (`cartoon/Zimage双采+三采+双放大…`). Its gate answers come from the historically-migrated `Zimage/` run (`delivery/migration-result-report.md`).

---

## 1. One-time setup

```bash
npm ci                                   # installs @playwright/test
npx playwright install chromium          # one-time browser download (needs the Intel proxy)
```

If `playwright install` fails on download, set the proxy first:
```bash
HTTPS_PROXY=http://proxy.ims.intel.com:911 npx playwright install chromium
```

## 2. Start a test agent (current code, dedicated ports)

The tests need a **current-code** backend (with `/api/gpu-nodes`) + a frontend that proxies to
it. Run a throwaway agent from this repo so you don't touch any other instance:

```bash
bash scripts/start-test-agent.sh         # backend :3002, frontend :5174
```

(The script prints the exact `PW_BASE_URL` / `PW_API` to use.) It sources the `env` file, so make
sure that exists: `cp env.example env` and fill `COPILOT_PROVIDER_API_KEY` + `COMFYUI_ROOT` +
`MODEL_ROOTS`.

> **Why a dedicated test agent?** The orchestrator keeps a one-run-per-process lock
> (`activeStepRuns`). A long-running agent may hold that lock and reject new tasks
> (`POST /api/tasks → 500 "another migration step is actively running"`). A fresh test agent
> always starts lock-free. **If you ever see that 500, restart the backend.**

## 3. Run the tests

```bash
# Layer 1 — fast GUI regression (run this after every frontend change)
PW_BASE_URL=http://172.16.114.105:5174 PW_API=http://127.0.0.1:3002 \
  npm run playwright:ui

# Layer 2 — live 双采 migration
PW_BASE_URL=http://172.16.114.105:5174 PW_API=http://127.0.0.1:3002 \
  MIGRATION_DEPTH=launch npm run playwright:migration   # → Step 05 (ComfyUI on XPU), ~30 min
PW_BASE_URL=http://172.16.114.105:5174 PW_API=http://127.0.0.1:3002 \
  MIGRATION_DEPTH=full   npm run playwright:migration   # → final step, hours
```

`PW_BASE_URL` = frontend URL, `PW_API` = backend URL (defaults in `playwright.config.ts`).

Layer 1 must run against a **freshly started** backend (the `beforeAll` hook clears leftover
tasks, but can't release a lock held by another run).

## 4. What "pass" means

- **Layer 1:** all `@ui` cases green. Covers the full GUI surface deterministically — this is the
  regression gate that should always be green.
- **Layer 2 `launch`:** the migration reaches **Step 05** (ComfyUI launched on XPU) with the GUI
  reflecting every step transition and gate along the way. Best-effort check for a `system_stats`
  / XPU event.
- **Layer 2 `full`:** the pipeline runs to the final step it can reach. A `hard_stop` at a
  *content* gate (e.g. missing source image, Step 12 manual GUI sign-off) counts as a pass — the
  point is that the pipeline + GUI got there and stayed correct. A `failed` step does not.

## 5. Why Layer 1 doesn't drive a live gate

Reaching a human gate requires running a step. Step 01's SDK agent runs for minutes, and the
one-run-per-process lock means a run-left-mid-step blocks everything (including the next suite
run's task creation). So the gate UI (`.question-card`) is verified in **Layer 2**, where the
migration naturally hits gates. Layer 1 stays deterministic and fast.

## 6. Files

- `tests/frontend-gui.spec.ts` (`@ui`) — Layer 1
- `tests/zimage-migration.spec.ts` (`@migration`) — Layer 2
- `tests/helpers/api.ts` — shared API helpers (createTask, runUntilGate, recordDecision, …)
- `tests/fixtures/zimage-shuangcai.json` — the workflow under test
- `playwright.config.ts` — `PW_BASE_URL` / `PW_API` / `PW_TIMEOUT_MS`
- `scripts/start-test-agent.sh` — start a throwaway test agent

## 7. Adding a case

- Reuse `tests/helpers/api.ts` for API calls; drive the UI via Playwright locators on the existing
  class hooks (`.pipeline-node`, `.step-detail h2`, `.tab`, `.artifact-browser`, `.gpu-node-card`,
  `.question-card`).
- Tag fast/deterministic cases `@ui`, live/long cases `@migration`.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `POST /api/tasks → 500 … another migration step is actively running` | A held run-lock. Restart the backend (`scripts/start-test-agent.sh` again, or kill+restart the process). |
| Layer 2 stuck at Step 01 for many minutes | Normal — Step 01's DeepSeek agent is slow. Give it time (per-step budget is 30 min). |
| Layer 2 hard-stops at Step 07/08/12 | Expected for a content reason (missing source image / manual GUI sign-off). Counts as a pass. |
| `playwright install` download fails | Run under `HTTPS_PROXY=http://proxy.ims.intel.com:911`. |
| ComfyUI never comes up on XPU (Step 05) | Check the agent's `gpu-nodes.json` points at a ComfyUI venv with XPU torch; check `/tmp/test-agent-backend.log`. |
| 404s from the frontend after starting it | You hit the `npx vite` wrong-version trap — `scripts/start-test-agent.sh` uses `./node_modules/.bin/vite` to avoid it; don't start the frontend with bare `npx vite`. |
