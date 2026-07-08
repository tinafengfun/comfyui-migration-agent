# Self-evolution + memory architecture: build status

> Companion to [docs/evolution-and-memory-design.md](evolution-and-memory-design.md).
> This document tracks what's been built, how it fits together, and what's pending.
> Last updated: 2026-06-25.

## At a glance

Eleven modules shipped. **Both layers of the two-layer knowledge design are closed** (recipes = hard injection, skills = soft injection) and **SQLite analytics tracks real-world recipe/skill efficacy**. Feedback collection is wired into orchestrator internals. A workflow with `CLIPLoader + qwen_*_vl_*_fp8*.safetensors` now gets the FP8 recipe auto-injected into the Step 02/04/05 prompt, FP8 feasibility skill injected into Step 02, feedback events auto-collected from hard-stops and failures, and recipe success rates queryable from the analytics DB.

| § | Module | Commit | Status |
|---|---|---|---|
| K | `paths.ts` single source of truth | `269d584` | ✅ shipped |
| A | JSON Schemas (skill / recipe / feedback) | `1281a1c` | ✅ shipped |
| F | ajv runtime validator | `f77a197` | ✅ shipped |
| G | per-task feedback log + HTTP | `4193071` | ✅ shipped |
| G.wire | feedback auto-collection in orchestrator | — | ✅ shipped |
| H | SQLite analytics DB (node:sqlite built-in) | — | ✅ shipped |
| I | recipe library + first real recipe | `d985c35` | ✅ shipped |
| L | recipe hard-injection into prompts | `636ce79` | ✅ shipped, smoke-verified |
| M | skill registry + soft injection (layer 2) | — | ✅ shipped |
| C | workspace purity linter | `6de1571` | ✅ shipped, real-pollution-verified |
| J | daily-check orchestrator (cron-ready) | `f9c402b` | ✅ shipped |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Source code                                                              │
│                                                                          │
│   recipes/nodes/*.json  ─┐                                               │
│   (committed,            │                                               │
│    version-controlled)   │      ┌──────────────────────────┐            │
│                          ├─────►│ recipeLibrary            │            │
│   recipes/nodes/*.json  ─┘      │  loadAllRecipes()        │            │
│                                 │  findRecipesForNode()    │            │
│                                 │  findRecipeById()        │            │
│                                 └──────────┬───────────────┘            │
│                                            │                            │
│   source workflow.json ──┐                 │                            │
│   (per-task, uploaded)   │                 │                            │
│                          ▼                 ▼                            │
│                  ┌──────────────────────────────┐                       │
│                  │ recipeInjector               │                       │
│                  │  extractNodeModelPairs()     │                       │
│                  │  findMatchingRecipes()       │ ── only for steps     │
│                  │  formatRecipesForPrompt()    │    02 / 04 / 05       │
│                  └──────────────┬───────────────┘                       │
│                                 │                                       │
│                                 ▼                                       │
│                  ┌──────────────────────────────┐                       │
│                  │ promptSkillCompiler          │                       │
│                  │  compileStepJob()            │                       │
│                  │  serializeStepJobForAgent()  │ ── prompt sent to LLM │
│                  └──────────────────────────────┘                       │
│                                                                          │
│   schemas/*.schema.json ──┐                                              │
│                           ├──────► schemaValidate                        │
│                           │          validate(kind, value)              │
│                           │          assertValid(kind, value)           │
│                           │              ▲                               │
│                           │              │ hard gate                     │
│                           │              │ before write                  │
│                           │              │                               │
│                           │      ┌───────┴────────────────┐              │
│                           │      │ feedbackLog            │              │
│                           │      │  appendFeedbackEvent() │              │
│                           │      │  listFeedbackEvents()  │              │
│                           │      └────────────────────────┘              │
│                           │                                              │
│   paths.ts ───────────────┴──────► GLOBAL_DIRS + per-task helpers        │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ cron (daily 09:07)
                                    ▼
                  ┌──────────────────────────────────────┐
                  │ scripts/daily-check.sh               │
                  │  ├─ lint-workspace-purity.mts (§C)   │
                  │  └─ validate-recipes.mts (§F)        │
                  └──────────────────────────────────────┘
```

## Module reference

### §K — `src/server/paths.ts`

Single source of truth for path constants and subdir/file names.

- Exports: `TASK_SUBDIRS`, `CACHE_SUBDIRS`, `STEP_OUTPUT_SUBDIR`, `TASK_FILES`, `GLOBAL_DIRS`, `SCHEMA_FILES`
- Per-task helpers: `taskDir`, `taskFeedbackDir`, `taskFeedbackEventsPath`, `taskEscalationDir`, `taskEscalationSummaryPath`
- Prompt-injection helpers: `buildAvailablePathsBlock`, `renderAvailablePathsBlock`
- Env-var overrides: `MIGRATION_RECIPES_DIR`, `MIGRATION_SCHEMAS_DIR`, `MIGRATION_PATCHES_DIR`, `MIGRATION_DEBUG_ARCHIVES_DIR`, `MIGRATION_ANALYTICS_DB` (all in `env.example`)

Callers must import constants from here; never inline `"feedback"` / `"previews"` / etc.

### §A — `schemas/*.schema.json`

Three Draft 2020-12 schemas:

| File | Required fields | Conditional |
|---|---|---|
| `skill-frontmatter.schema.json` | skillId, version, tier, provenance | tier=on-demand requires trigger |
| `recipe.schema.json` | recipeId, version, nodeType, xpuSupport, knownIssues, provenance | xpuSupport=patched requires patchFile |
| `feedback-event.schema.json` | id, taskId, stepId, createdAt, source, type, severity, message, status | — |

### §F — `src/server/schemaValidate.ts`

ajv-based runtime gate. Lazy load, cached, reset-able.

```typescript
import { validate, assertValid, formatResult } from "./schemaValidate";

const r = validate("feedbackEvent", event);
if (!r.ok) console.warn(formatResult(r));

assertValid("feedbackEvent", event);  // throws — use on write paths
```

`validate(kind, value)` never throws for invalid data; only throws if the schema file itself is missing/corrupt.

### §G — `src/server/feedbackLog.ts`

Per-task JSONL feedback log at `workspaces/<taskId>/feedback/feedback-events.jsonl`.

- `appendFeedbackEvent(workspaceRoot, taskId, input)` auto-fills id/taskId/createdAt/status, validates via §F, atomic append
- `listFeedbackEvents(workspaceRoot, taskId)` tolerant reader — corrupt lines in `corrupt[]`, healthy events in `events[]`
- HTTP: `POST /api/tasks/:taskId/feedback` (422 on schema fail), `GET /api/tasks/:taskId/feedback`

#### §G.wire — orchestrator auto-collection

Feedback events are now auto-written from four orchestrator-internal paths, not just HTTP:

| Trigger | `type` | `severity` | `proposedAction` |
|---|---|---|---|
| `terminateWithHardStop` | `agent_bug` | `blocker` | `evolve_prompt` if `improvementStrategy` given, else `record_only` |
| Step failure (unhandled exception) | `comfyui_bug` | `blocker` | `record_only` |
| SDK step timeout (paused) | `agent_bug` | `degrade` | `escalate_opencode` |
| Non-routine human decision | `user_preference` | keyword-based (`blocker`/`degrade`/`nit`) | — |

Routine approvals (`yes`/`ok`/`continue`/`approve`/`proceed`/`1`/…) are skipped to keep the log focused on signal. All writes go through `recordFeedback()`, which is `await`-ed but wraps `appendFeedbackEvent` in try/catch — a feedback write failure never breaks the orchestrator flow.

### §I — `src/server/recipeLibrary.ts` + `recipes/nodes/`

Recipe loader + the first real recipe.

- `loadAllRecipes(root?)` walks `recipes/` recursively, validates each JSON, returns `{recipes, invalid, unparseable}`
- `findRecipesForNode(nodeType, modelFilename?, root?)` filters by nodeType + optional modelPattern glob. Recipes with no `modelPattern` are catch-alls.
- `findRecipeById(recipeId, root?)` exact lookup
- `recipes/nodes/CLIPLoader-qwen25-vl-fp8.json` — the first real recipe. Three workarounds in priority order, retireCondition tied to `comfy_kitchen >= 0.3.0`.

### §L — `src/server/recipeInjector.ts` + wiring

The hard-injection layer. Closes the loop: workflow → recipe match → prompt.

- `extractNodeModelPairs(workflow)` walks `workflow.nodes[].widgets_values`, picks `.safetensors/.ckpt/.pt/.pth/.onnx/.gguf/.bin` strings. Tolerates malformed JSON.
- `findMatchingRecipes(pairs, root?)` dedupes by recipeId, sorts alphabetically.
- `formatRecipesForPrompt(recipes)` compact markdown block (id, support, patchClass, knownIssues, numbered workarounds with tradeoffs, retireCondition).
- `injectRecipesForWorkflow({workflowPath, stepId, root?})` top-level entry — only fires for steps in `RECIPE_INJECTION_STEPS = {"02", "04", "05"}`. Best-effort: returns `""` on missing file / bad JSON / no match / any error.

Wired through `StepJob.matchedRecipes` (added to `src/shared/types.ts`) and injected by `serializeStepJobForAgent` between learnedRules and step instructions.

**Verified end-to-end**: a workflow with `CLIPLoader + qwen_2.5_vl_7b_fp8_scaled.safetensors` produces a Step 04 prompt containing `CLIPLoader-qwen25-vl-fp8`, the dequant-before-move workaround text, and the retireCondition. Step 07 (outside the injection set) correctly gets no recipe.

### §M — `src/server/skillRegistry.ts` + `src/server/skillInjector.ts`

The soft-injection layer. Closes the two-layer design: recipes handle deterministic nodeType+modelPattern, skills handle trigger-based matching (stepId + asset/node/model/env patterns).

- `loadRegistry(path?)` reads `.demo-state/skills-registry.json` for active skill IDs
- `loadActiveSkills(path?, dir?)` loads .md files, parses YAML frontmatter, validates against `skill-frontmatter.schema.json`
- `evaluateTrigger(skill, context)` — tier must be `on-demand`; stepId must match; condition keys AND'd, anyOf entries OR'd; globMatch for asset/model patterns, versionGte for envGte
- `injectSkillsForWorkflow({workflowPath, stepId})` — top-level entry, fires for ANY step (trigger handles gating), returns "" on no match
- Wired through `StepJob.matchedSkills` (added to `src/shared/types.ts`)

**Three on-demand skills shipped**: `fp8-feasibility-checklist` (step 02, FP8 models), `xpu-attention-fallback` (step 04, AIO_Preprocessor), `seedvr2-loader-workaround` (step 04, SeedVR2Upscaler).

### §H — `src/server/analyticsDb.ts` + `scripts/sync-analytics.mts`

SQLite analytics using Node.js v24 built-in `node:sqlite` (zero new npm deps). Tables: `tasks`, `feedback`, `recipe_usage`, `skill_injections`.

- `recordRecipeApplied(taskId, stepId, recipeIds)` — fired from `compileStepJob` when recipes match
- `recordRecipeOutcome(taskId, stepId, "success"|"failed")` — fired from orchestrator on step complete/fail
- `computeRecipeEfficacy(recipeId?)` — aggregates applied/success/failed counts + successRate
- `syncFeedbackFromJsonl(workspaceRoot)` — batch-syncs JSONL feedback events into SQLite (dedup by event id)
- All writers fire-and-forget (try/catch + console.warn), never break the migration pipeline

`scripts/sync-analytics.mts` provides a cron-friendly CLI: `npx tsx scripts/sync-analytics.mts`.

### §C — `src/server/lintWorkspacePurity.ts` + `scripts/lint-workspace-purity.mts`

Catches agent pollution in the ComfyUI checkout (design §4.1).

| Pattern | Severity | Category |
|---|---|---|
| `*.agent-patched` | error | patch_backup |
| `*.swp` / `*.swo` | error | swap_file |
| garbage names (single char, all-same-char, `pythonXXX...`) | error | garbage_name |
| untracked dump | warning | untracked_dump |
| tracked-modified | info | tracked_modified |

Allowed roots: `agent-demo/`, `patches/`, `debug-archives/`, `.git/` (configurable).

**Real-world validated**: caught all 8 actual pollution files in the live ComfyUI checkout (3 typo/garbage files, 2 `.agent-patched` backups, 3 vim swap files) and correctly marked `comfy/ops.py` + `nodes.py` as info-severity tracked modifications (the intentional §I FP8 patch).

### §J — `scripts/daily-check.sh` + `scripts/validate-recipes.mts`

Single command that runs §C + §F together. Cron-ready.

```bash
bash scripts/daily-check.sh [--comfyui-root <path>]
```

Output teed to `logs/daily-check.log`. Exit status = sum of sub-check RCs.

**Cron installation** (single line in `crontab -e`):
```
7 9 * * * /home/intel/tianfeng/comfy/ComfyUI/agent-demo/scripts/daily-check.sh >> /home/intel/tianfeng/comfy/ComfyUI/agent-demo/logs/cron.log 2>&1
```

## Common tasks

### Add a new recipe

1. Write `recipes/nodes/<nodeType>-<model-hint>.json` matching `schemas/recipe.schema.json`. Use `recipes/nodes/CLIPLoader-qwen25-vl-fp8.json` as a template.
2. Validate locally:
   ```bash
   npx tsx scripts/validate-recipes.mts
   ```
3. Commit. The recipe is now auto-injected for steps 02/04/05 of any workflow whose nodes match.

### Manually run the daily check

```bash
bash scripts/daily-check.sh --comfyui-root /home/intel/tianfeng/comfy/ComfyUI
cat logs/daily-check.log
```

### Add a feedback event via HTTP

```bash
curl -X POST http://127.0.0.1:3001/api/tasks/<taskId>/feedback \
  -H 'Content-Type: application/json' \
  -d '{
    "stepId": "05",
    "source": "human",
    "type": "comfyui_bug",
    "severity": "blocker",
    "message": "CLIPLoader segfaults on XPU"
  }'
```

Response 201 = appended. 422 = schema validation failed. The event lands in `workspaces/<taskId>/feedback/feedback-events.jsonl`.

### Verify recipe injection for a workflow

Drop into a tsx REPL with `process.chdir(agentDemoRoot)` then:
```typescript
import { injectRecipesForWorkflow } from "./src/server/recipeInjector";
const out = await injectRecipesForWorkflow({
  workflowPath: "/path/to/workflow.json",
  stepId: "04"
});
console.log(out);  // non-empty if any recipe matches
```

## What's still pending

| § | What | Why it matters | Effort |
|---|---|---|---|
| (J.2) | Pre-commit hook | Run §C + §F locally before push. The cron half is shipped; the pre-commit half is a 1-hour follow-up. | 1 hour |

## Design contracts to preserve

These invariants were hard-won. Don't break them without a design discussion:

1. **Recipes match by nodeType + modelPattern only.** If you need richer triggers, that's a skill, not a recipe. (feedback memory: two_layer_injection)
2. **Recipe injection only happens on steps 02/04/05.** Other steps don't see recipes. Adding a step requires updating `RECIPE_INJECTION_STEPS` and confirming the prompt-budget impact.
3. **Schema validation is a write-path gate, not a read-path check.** `appendFeedbackEvent` calls `assertValid` before write; `listFeedbackEvents` is tolerant of corrupt lines.
4. **`loadAllRecipes` is lazy and best-effort.** Don't add caching that could serve stale recipes after a git pull.
5. **`lintWorkspacePurity` is read-only.** Never auto-delete pollution — humans review the report first. A `--fix` mode is fine to add later but must quarantine, not delete.

## References

- Design doc: [docs/evolution-and-memory-design.md](evolution-and-memory-design.md)
- Backlog: [docs/backlog-workspace-management.md](backlog-workspace-management.md), [docs/backlog-context-optimization.md](backlog-context-optimization.md)
- Feedback memory: `feedback_two_layer_injection.md` (in Claude's project memory)
