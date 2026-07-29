/**
 * Backend-owned, deterministic writer for the per-step migration flow's
 * `task-state.json` ledger. Replaces the prior design where every per-step
 * Copilot SDK session hand-maintained this file itself (see agent.md's old
 * Common Migration Contract rule 12) -- that produced a real corruption
 * (Step 13's completion entry landing outside the `steps` array) and, more
 * fundamentally, meant an LLM was the sole author of structurally-critical
 * shared state with no backend validation.
 *
 * This module assembles the ledger entirely from data the backend already
 * tracks authoritatively (`MigrationTask.steps`, `StateStore.listDecisions`)
 * -- no parsing of agent-written content is required to produce it. Any
 * narrative continuity notes an agent wants to leave for the next step's
 * fresh session belong in a separate, optional, freeform
 * `artifacts/step-handoffs/{step}-handoff.md` file (never parsed as JSON, so
 * malformed content there can never corrupt this shared ledger) -- this
 * mirrors the `step-handoffs/` convention already used by phase1Agent.ts's
 * (separate, unreachable) monolithic-driver mode.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { HumanDecision, MigrationTask } from "../shared/types";
import { writeJson } from "./fsUtils";
import { getLayoutForTask } from "./taskWorkspaces";

export interface TaskStateLedgerStep {
  id: string;
  status: string;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  handoff_ref?: string;
}

/**
 * A backend/tool fault recorded when an ask_user dispatch fails as a tool
 * error (NOT a human "no answer"). Distinct from a human-gate event: this
 * records that the tool itself failed to reach a human decision, requiring
 * operator attention -- it is never an auto-proceed signal (the permanently
 * rejected gate-skip pattern stays banned).
 */
export interface BackendToolFault {
  id: string;
  taskId: string;
  stepId?: string;
  tool: string;
  reason: string;
  occurredAt: string;
}

export interface TaskStateLedger {
  schema_version: 1;
  generated_by: "orchestrator";
  task_id: string;
  status: string;
  current_step_id?: string;
  workflow_path: string;
  workspace_path: string;
  artifact_path: string;
  updated_at: string;
  steps: TaskStateLedgerStep[];
  human_decisions: HumanDecision[];
  backend_faults: BackendToolFault[];
}

const BACKEND_FAULTS_FILENAME = "backend-faults.json";

/**
 * Pure assembly of the ledger shape from already-authoritative backend data.
 * `handoffRefs` maps step id -> relative handoff path, precomputed by the
 * caller (`writeTaskStateLedger`) since checking the filesystem isn't a pure
 * operation.
 */
export function buildTaskStateLedger(
  task: MigrationTask,
  decisions: HumanDecision[],
  handoffRefs: Record<string, string> = {},
  backendFaults: BackendToolFault[] = []
): TaskStateLedger {
  return {
    schema_version: 1,
    generated_by: "orchestrator",
    task_id: task.id,
    status: task.status,
    current_step_id: task.steps.find((step) => step.status !== "completed")?.id,
    workflow_path: task.workflowPath,
    workspace_path: task.workspacePath,
    artifact_path: task.artifactPath,
    updated_at: new Date().toISOString(),
    steps: task.steps.map((step) => ({
      id: step.id,
      status: step.status,
      summary: step.summary,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      error: step.error,
      ...(handoffRefs[step.id] ? { handoff_ref: handoffRefs[step.id] } : {})
    })),
    human_decisions: decisions,
    backend_faults: backendFaults
  };
}

/**
 * Writes the ledger to `<workspacePath>/task-state.json` (the same location
 * already used by phase1Agent.ts and assetReplacement.ts's
 * getComfyUIApiUrl -- see getLayoutForTask), atomically via the existing
 * writeJson() temp-file+rename pattern.
 */
export async function writeTaskStateLedger(
  task: MigrationTask,
  decisions: HumanDecision[]
): Promise<void> {
  const handoffRefs: Record<string, string> = {};
  for (const step of task.steps) {
    const relRef = path.join("step-handoffs", `${step.id}-handoff.md`);
    const absPath = path.join(task.artifactPath, relRef);
    if (await fileExists(absPath)) {
      handoffRefs[step.id] = relRef;
    }
  }
  const backendFaults = await readBackendFaults(task.artifactPath);
  const ledger = buildTaskStateLedger(task, decisions, handoffRefs, backendFaults);
  const taskStatePath = getLayoutForTask(task).taskStatePath;
  await writeJson(taskStatePath, ledger);
}

/**
 * Appends a backend/tool fault to the per-task `backend-faults.json` sidecar
 * (under artifactPath) and reflects it immediately into `task-state.json` if a
 * ledger already exists on disk, so the operator sees the fault in the ledger
 * without waiting for the next `writeTaskStateLedger` rebuild. Called from the
 * ask_user dispatch path (`copilotSdkRunner.ts`) when ask_user returns a tool
 * error that exhausts retries. Never an auto-proceed signal.
 */
export async function recordBackendToolFault(input: {
  taskId: string;
  stepId?: string;
  tool: string;
  reason: string;
  artifactPath: string;
  workspacePath: string;
}): Promise<BackendToolFault> {
  const fault: BackendToolFault = {
    id: `fault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: input.taskId,
    stepId: input.stepId,
    tool: input.tool,
    reason: input.reason,
    occurredAt: new Date().toISOString()
  };
  const existing = await readBackendFaults(input.artifactPath);
  const updated = [...existing, fault];
  const sidecarPath = path.join(input.artifactPath, BACKEND_FAULTS_FILENAME);
  await writeJson(sidecarPath, updated);
  // Reflect immediately into the ledger if one already exists on disk. If no
  // ledger exists yet, the next writeTaskStateLedger call will pick up the
  // sidecar (it reads backend-faults.json before building the ledger).
  const taskStatePath = path.join(input.workspacePath, "task-state.json");
  try {
    const raw = await fs.readFile(taskStatePath, "utf8");
    const ledger = JSON.parse(raw) as TaskStateLedger;
    ledger.backend_faults = updated;
    await writeJson(taskStatePath, ledger);
  } catch {
    // No ledger on disk yet (or unreadable) -- sidecar is the source of truth.
  }
  return fault;
}

async function readBackendFaults(artifactPath: string): Promise<BackendToolFault[]> {
  try {
    const raw = await fs.readFile(path.join(artifactPath, BACKEND_FAULTS_FILENAME), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BackendToolFault[]) : [];
  } catch {
    return [];
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
