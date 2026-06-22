# Backlog: Context Memory Optimization

> Status: BACKLOG — postponed until business logic is verified correct across all 14 steps.
> Created: 2026-05-28
> Last updated: 2026-06-22 (code review)

## Background

The migration pipeline runs 14 steps through a Copilot SDK agent. Each step shares a single SDK session (`sessionId = task-${taskId}`), causing cumulative context growth. Profiling reveals the context exceeds model limits by mid-pipeline, leading to silent truncation and degraded agent performance.

## Empirical Data

### Test Run: 8095ca95 (deepseek-v4-flash, 256K context)

| Step | Prompt | Assistant | Tool I/O | Cumulative | % of 256K |
|------|--------|-----------|----------|------------|-----------|
| 01   | 13,144t | 7,052t   | 22,388t  | 43,334t    | 17%       |
| 02   | 7,824t  | 4,954t   | 20,335t  | 63,303t    | 25%       |
| 04   | 5,624t  | 1,054t   | 5,938t   | 68,095t    | 27%       |
| 05   | 6,281t  | 2,224t   | 9,925t   | 80,901t    | 32%       |

Extrapolated to 14 steps: ~280K tokens (exceeds 256K limit).

### Context Composition

| Category | Tokens | % | Reuse |
|----------|--------|---|-------|
| Tool I/O (bash, file reads, grep) | 58,585t | 75% | One-time — disposable |
| Assistant thinking/reasoning | 15,283t | 20% | Mostly intermediate — disposable |
| System overhead (SDK messages) | 4,215t | 5% | Identical every step — redundant |
| Step prompts | ~8,200t avg | — | Per-step only — not reused |

**Key insight**: ~95% of accumulated context is disposable. Only artifact paths and key decisions (~5%) need to transfer between steps.

### Cross-Step File Reference Analysis

Multi-step files (hot content):
- `00-intake-preflight.md` — read by steps 01, 02, 04, 05
- `01-assets.csv` — read by steps 02, 04, 05
- `01-output-manifest.json` — read by steps 02, 04, 05
- `source/*.json` (original workflow) — read by steps 01, 02, 04

One-time files: majority of tool I/O outputs, grep results, intermediate bash outputs.

---

## Backlog Items

### Code review (2026-06-22)

| Item | Status as of review | Notes |
|------|---------------------|-------|
| P0 Step Isolation | **未做** | `copilotSdkRunner.ts:85` 仍 `sessionId = task-${job.taskId}`，每步 `resumeSession` |
| P1 Artifact Summary | **未做** | 无 `stepSummary.ts`；仅有 LLM 自产 final summary |
| P2 Tool I/O Eviction | **部分做** | `contextRetention.ts` 已实现持久化层分类（drop/db_only/debug_only），但只控制持久化，SDK session 内部累积未处理 |
| P3 System Dedup | **未做** | 每次 resume 带完整 systemMessage（做完 P0 自动消失） |
| P4 Script固化 | **未做** | 无 `stepScripts/` 目录 |
| P5 SQLite | **未做** | `package.json` 无 sqlite/drizzle 依赖 |

---

### P0: Step Isolation (Context Explosion Fix)

**Problem**: All steps share one SDK session. By step 05, the agent carries 80K tokens of history, 75% of which is disposable tool I/O from prior steps.

**Solution**: Each step creates a new SDK session. Context transfers via artifact files only (which is already the primary mechanism — the session history is redundant).

```
Before:  Step N → resume(session) → carries ALL history → Step N+1
After:   Step N → write artifacts → new session(prompt + artifact refs) → Step N+1
```

**Expected impact**:
- Per-step context: ~10K (prompt 8K + summary 2K) instead of 80K+
- 14 steps total: ~140K instead of ~280K
- Never exceeds model limit regardless of pipeline length

**Files to change**:
- `src/server/copilotSdkRunner.ts` — change session strategy (lines 85, 241-260)
- `src/server/promptSkillCompiler.ts` — add "prior step summary" to prompt
- `src/server/orchestrator.ts` — update step handoff logic

**Risk**: Steps that genuinely need to see prior tool output (e.g., multi-step debugging) won't have it in chat history. Mitigation: explicit artifact reading in the prompt.

**Trade-off noted by user**: User wants to first collect cross-step shared context statistics before isolating. This is deferred until after business logic is correct.

---

### P1: Artifact Summary Layer

**Problem**: Each step reads 5-10 prior artifacts in full. A single artifact like `01-assets.csv` can be 50KB. The step prompt itself is 8-13K tokens, much of which is artifact content.

**Solution**: Auto-generate a structured summary after each step completes:

```json
{
  "stepId": "01",
  "status": "completed",
  "keyDecisions": ["resolved 12 models to local paths", "found 3 custom nodes"],
  "artifactsWritten": ["01-assets.csv", "01-output-manifest.json"],
  "warnings": ["model X not found locally"],
  "summary": "Identified 45 nodes, resolved 12 model assets..."
}
```

Subsequent steps read the 200-token summary instead of the 50KB artifact.

**Expected impact**: Step prompt from ~13K → ~5K tokens. Cumulative savings: ~100K across 14 steps.

**Files to change**:
- New: `src/server/stepSummary.ts` — post-step summary generator
- `src/server/copilotSdkRunner.ts` — call summary after step completion
- `src/server/promptSkillCompiler.ts` — reference summaries instead of full artifacts

---

### P2: Tool I/O Eviction

**Problem**: Tool I/O (bash output, file reads, grep results) constitutes 75% of context but is almost entirely one-time. The agent reads a file, extracts the info it needs, and never references the raw output again.

**Solution**: After a step completes, strip tool I/O from the session history, keeping only the final assistant message. This is complementary to P0 (step isolation) — if steps are isolated, this happens automatically.

**Partial implementation (2026-06-22 review)**: `src/server/contextRetention.ts` already classifies SDK events into retention classes (`prompt_required` / `prompt_summary` / `db_only` / `debug_file_only` / `drop`) and is wired into `copilotSdkRunner.ts:448`. However, this only controls **what gets persisted** to disk and the API event stream — it does NOT truncate tool I/O inside the SDK session that the LLM sees on `resumeSession`. The actual session-context eviction still needs P0 (or SDK-level transcript editing).

If step isolation is not yet done, an alternative is to truncate tool I/O in the session on resume:
- Keep: `assistant.message` events (agent's conclusions)
- Drop: `tool.execution_complete` output > 1KB (replace with "[output truncated, see artifact]")
- Keep: `tool.execution_start` (shows what was attempted)

**Expected impact**: ~58K tokens saved across 5 steps (the fraction not already handled by `contextRetention.ts`).

**Files to change**:
- `src/server/contextRetention.ts` — add tool I/O eviction rules for session resume
- `src/server/copilotSdkRunner.ts` — apply eviction on session resume (currently only applies to recorder persistence)

---

### P3: System Message Deduplication

**Problem**: SDK system message (~750 tokens) is sent identically on every step. Across 14 steps, that's 10.5K tokens of pure duplication.

**Solution**: The SDK handles this internally. If we do step isolation (P0), each new session gets its own system message and there's no duplication. If we stay with shared sessions, we can't easily deduplicate without modifying the SDK.

**Expected impact**: ~10K tokens saved. Low priority since P0 makes this moot.

---

### P4: Operational Knowledge → Script固化

**Problem**: Steps like 01 (Asset Resolution) perform nearly identical operations every run: read workflow → scan nodes → resolve model paths → generate CSV. Yet each time the LLM reasons from scratch, costing tokens and time.

**Solution**: For stable, well-understood operations, replace LLM reasoning with deterministic scripts:

```
L1 Rule  (已有): "use stat instead of ls -l for file sizes"
L2 Skill (缺失): compiled prompt fragments for common patterns
L3 Script (缺失): deterministic shell/Node scripts for proven operations
```

Example candidates for script固化:
- Step 01 Asset Resolution: parse workflow JSON → extract node types → match against model registry
- Step 03 Inventory: count nodes, classify types, build manifest
- Step 08 Smoke Test: launch ComfyUI, run workflow, check output

**Expected impact**: 3-5x faster execution, ~80% token reduction for scriptable steps.

**Files to change**:
- New: `src/server/stepScripts/` — deterministic step implementations
- `src/server/orchestrator.ts` — route to script or LLM based on confidence
- `src/server/workflowKnowledge.ts` — track which steps are scriptable

---

### P5: SQLite Persistence Layer

**Problem**: All data stored as flat files (JSON/MD/CSV/JSONL). Querying is slow, cross-task comparison is manual, and there's no indexing.

**Solution**: Add SQLite for structured data:
- Artifact metadata (path, size, step, type)
- Step results (status, duration, token usage, tool calls)
- Context statistics (per-step breakdown, cumulative growth)
- Knowledge base (learned rules, injection history)

Keep flat files for large text content (prompts, transcripts, source code).

**Expected impact**: Faster queries, better analytics, foundation for multi-task optimization.

**Files to change**:
- New: `src/server/db.ts` — SQLite schema and access layer
- `src/server/contextProfiler.ts` — write stats to DB
- `src/server/stepArtifactScaffold.ts` — register artifacts in DB
- `src/server/workflowKnowledge.ts` — migrate from JSON files

---

## Tools Built for This Investigation

| Tool | File | Purpose |
|------|------|---------|
| Context Profiler | `src/server/contextProfiler.ts` | Analyzes SDK session files, reports per-step context breakdown |
| Context Watcher | `src/server/contextWatcher.ts` | Real-time monitor, polls for new steps, prints live updates |
| DeepSeek Proxy | `src/server/deepseekProxy.ts` | Injects `thinking.type=disabled` for deepseek-v4-flash compatibility |

### Profiler Usage

```bash
# One-shot analysis
npx tsx src/server/contextProfiler.ts workspaces/<task-id>/artifacts

# Real-time watch for new task
npx tsx src/server/contextWatcher.ts --new

# Watch specific task
npx tsx src/server/contextWatcher.ts workspaces/<task-id>/artifacts
```

---

## Dependencies Between Backlog Items

```
P0 (Step Isolation) ──┐
                       ├──→ P2 (Tool I/O Eviction) becomes moot
P1 (Summary Layer) ────┘
                       ├──→ P3 (System Dedup) becomes moot
P4 (Script固化) ─────── independent, can start anytime
P5 (SQLite) ────────── independent, can start anytime
```

Recommended implementation order: P0 → P1 → P4 → P5

---

## Model Configuration

| Setting | Value | Notes |
|---------|-------|-------|
| Model | deepseek-v4-flash | 256K native context, $0.14/1M tokens |
| Provider | OpenAI-compatible via local proxy | `http://127.0.0.1:8765` |
| Thinking mode | Disabled | Proxy injects `thinking.type=disabled` |
| Proxy | `src/server/deepseekProxy.ts` | Required: SDK doesn't support DeepSeek thinking params |
| Corporate proxy | `http://child-prc.intel.com:912` | Node.js needs `https-proxy-agent` to reach api.deepseek.com |
| Max prompt tokens | 200,000 | 256K - 56K headroom for output |
| Max output tokens | 16,000 | |

### Startup Sequence

```bash
# Terminal 1: Start proxy
source /home/intel/tianfeng/comfy/env
DEEPSEEK_API_KEY=sk-xxx npx tsx src/server/deepseekProxy.ts

# Terminal 2: Start backend
source /home/intel/tianfeng/comfy/env
npm run start
```
