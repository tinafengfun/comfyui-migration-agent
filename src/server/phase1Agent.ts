import fs from "node:fs/promises";
import path from "node:path";
import type {
  HumanDecision,
  MigrationStepDefinition,
  MigrationTask,
  StepJob,
  StepStatus
} from "../shared/types";
import type { AppConfig } from "./config";
import { ensureDir, readJson, writeJson } from "./fsUtils";
import { getLayoutForTask } from "./taskWorkspaces";

const phase1AgentName = "phase1-monolithic-copilot-driver";
const phase1ContextDir = "phase1-context";
const phase1StepHandoffDir = path.join(phase1ContextDir, "step-handoffs");
const phase1TaskStateFile = "task-state.json";
const phase1DriverPromptFile = path.join(phase1ContextDir, "phase1-driver-prompt.md");
const phase1RunningSummaryFile = path.join(phase1ContextDir, "running-summary.md");
const phase1ContextDebtFile = path.join(phase1ContextDir, "context-debt.json");
const phase1ExtractionFile = path.join(phase1ContextDir, "phase3-extraction-candidates.json");
const phase1ContextBudgetFile = path.join(phase1ContextDir, "context-budget.json");

export interface Phase1DriverArtifacts {
  taskStatePath: string;
  promptPath: string;
  runningSummaryPath: string;
  contextDebtPath: string;
  phase3ExtractionPath: string;
  contextBudgetPath: string;
  stepHandoffDir: string;
  job: StepJob;
}

export interface Phase1StepState {
  id: string;
  name?: string;
  status: string;
  summary?: string;
  artifacts?: string[];
  completion_decision?: Record<string, unknown>;
  next_step_context?: Record<string, unknown>;
  context_debt?: unknown[];
}

export interface Phase1TaskState {
  schema_version: number;
  agent: string;
  mode: "monolithic_driver";
  task_id: string;
  status: string;
  current_step_id?: string;
  workflow_path: string;
  workspace_path: string;
  artifact_path: string;
  updated_at: string;
  steps: Phase1StepState[];
  human_decisions: HumanDecision[];
  claim_boundary: Record<string, unknown>;
  compaction: {
    running_summary: string;
    context_debt: string;
    phase3_extraction_candidates: string;
    context_budget: string;
    step_handoffs: string;
    compact_checkpoints: string;
    required_after_each_step: boolean;
  };
}

export async function preparePhase1Driver(input: {
  config: AppConfig;
  task: MigrationTask;
  steps: MigrationStepDefinition[];
  decisions: HumanDecision[];
}): Promise<Phase1DriverArtifacts> {
  const stepHandoffDir = path.join(input.task.artifactPath, phase1StepHandoffDir);
  await ensureDir(stepHandoffDir);

  const taskStatePath = getLayoutForTask(input.task).taskStatePath;
  const runningSummaryPath = path.join(input.task.artifactPath, phase1RunningSummaryFile);
  const contextDebtPath = path.join(input.task.artifactPath, phase1ContextDebtFile);
  const phase3ExtractionPath = path.join(input.task.artifactPath, phase1ExtractionFile);
  const contextBudgetPath = path.join(input.task.artifactPath, phase1ContextBudgetFile);
  const promptPath = path.join(input.task.artifactPath, phase1DriverPromptFile);

  const taskState = compactPhase1TaskStateForStorage(await buildPhase1TaskState({
    task: input.task,
    steps: input.steps,
    decisions: input.decisions,
    taskStatePath
  }));
  await writeJson(taskStatePath, taskState);
  await ensureRunningSummary(runningSummaryPath, input.task, taskState);
  await ensureContextDebt(contextDebtPath);
  await ensurePhase3Extraction(phase3ExtractionPath);

  const prompt = await compilePhase1DriverPrompt({
    config: input.config,
    task: input.task,
    steps: input.steps,
    taskState,
    taskStatePath,
    runningSummaryPath,
    contextDebtPath,
    phase3ExtractionPath,
    contextBudgetPath,
    stepHandoffDir
  });
  await fs.writeFile(promptPath, prompt, "utf8");

  return {
    taskStatePath,
    promptPath,
    runningSummaryPath,
    contextDebtPath,
    phase3ExtractionPath,
    contextBudgetPath,
    stepHandoffDir,
    job: {
      taskId: input.task.id,
      stepId: "phase1",
      stepName: "Phase 1 monolithic migration driver",
      promptPath,
      skillPath: path.join(input.config.draftDocRoot, "migration-workflow-v2", "agent.md"),
      workspacePath: input.task.workspacePath,
      artifactPath: input.task.artifactPath,
      workflowPath: input.task.workflowPath,
      modelRoots: input.config.modelRoots,
      comfyuiRoot: input.config.comfyuiRoot,
      instructions: prompt,
      constraints: [
        "Run the 00-13 migration in this single backend-controlled session until completion, human gate, hard stop, or failure.",
        "Update workspace task-state.json after every step transition.",
        "Write all step outputs and compaction artifacts under the task artifact folder.",
        "Respect artifacts/phase1-context/context-budget.json: checkpoint on warning and stop before starting a new step on critical.",
        "Do not bypass, delete, disable, collapse, or replace workflow nodes to force success.",
        "Do not persist credentials or secret values."
      ],
      requiredContext: {
        workflowPath: input.task.workflowPath,
        workspacePath: input.task.workspacePath,
        artifactPath: input.task.artifactPath,
        taskStatePath,
        runningSummaryPath,
        contextDebtPath,
        phase3ExtractionPath,
        contextBudgetPath,
        stepHandoffDir,
        phase1AgentContractPath: path.join(
          input.config.draftDocRoot,
          "migration-workflow-v2",
          "agent.md"
        ),
        modelRoots: input.config.modelRoots,
        comfyuiRoot: input.config.comfyuiRoot
      },
      expectedArtifacts: [
        phase1TaskStateFile,
        phase1RunningSummaryFile,
        phase1ContextDebtFile,
        phase1ExtractionFile,
        phase1DriverPromptFile
      ],
      humanGates: [
        "Use the web human-decision channel for any Phase 1 gate. The gate must name the exact step, blocker, choices, claim-boundary impact, decision background/reason/scene, terminology explanations, and consequences/follow-up for every choice."
      ],
      hardStopRules: [
        "Stop if success would require bypassing or semantically changing workflow nodes.",
        "Stop if required source-identical assets are unavailable and no human-approved substitute exists.",
        "Stop if a required secret would need to be persisted.",
        "Stop if required upstream context cannot be repaired safely from artifacts."
      ]
    }
  };
}

export async function readPhase1TaskState(task: MigrationTask): Promise<Phase1TaskState> {
  const taskStatePath = getLayoutForTask(task).taskStatePath;
  const state = await readJson<Phase1TaskState | undefined>(taskStatePath, undefined);
  if (!state) {
    throw new Error(`Phase 1 task-state.json was not found: ${taskStatePath}`);
  }
  if (state.agent !== phase1AgentName || state.mode !== "monolithic_driver") {
    throw new Error(`Invalid Phase 1 task-state.json agent/mode at ${taskStatePath}`);
  }
  if (!Array.isArray(state.steps)) {
    throw new Error(`Invalid Phase 1 task-state.json steps array at ${taskStatePath}`);
  }
  const corruptedStepIds = state.steps
    .map((step, index) => (typeof step !== "object" || step === null || Array.isArray(step) ? index : -1))
    .filter((index) => index >= 0);
  if (corruptedStepIds.length > 0) {
    // Auto-recover: rebuild step objects from the API task steps and surviving object entries
    const apiSteps = task.steps;
    const surviving = state.steps.filter(
      (s): s is Phase1StepState => typeof s === "object" && s !== null && !Array.isArray(s)
    );
    // Derive step definitions from the API (authoritative for id/name/status order)
    const stepDefs: Phase1StepState[] = apiSteps.map((apiStep) => {
      const existing = surviving.find((s) => s.id === apiStep.id);
      return {
        id: apiStep.id,
        name: (apiStep as unknown as Record<string, unknown>).name as string | undefined ?? `Step ${apiStep.id}`,
        status: (existing?.status as string) ?? apiStep.status,
        summary: (existing?.summary as string) ?? apiStep.summary ?? undefined,
        artifacts: (existing?.artifacts as string[]) ?? [],
        completion_decision: (existing?.completion_decision as Record<string, unknown>) ?? {},
        next_step_context: (existing?.next_step_context as Record<string, unknown>) ?? {},
        context_debt: (existing?.context_debt as unknown[]) ?? []
      };
    });
    state.steps = stepDefs;
    // Write the recovered state back so the agent sees corrected data
    await writeJson(taskStatePath, state);
  }
  return state;
}

export async function compactStoredPhase1TaskState(task: MigrationTask): Promise<Phase1TaskState> {
  const taskStatePath = getLayoutForTask(task).taskStatePath;
  const state = await readPhase1TaskState(task);
  const compact = compactPhase1TaskStateForStorage(state);
  if (JSON.stringify(compact) !== JSON.stringify(state)) {
    await writeJson(taskStatePath, compact);
  }
  return compact;
}

export function compactPhase1TaskStateForStorage(state: Phase1TaskState): Phase1TaskState {
  return {
    ...state,
    steps: state.steps.map(compactPhase1StepState)
  };
}

export function normalizePhase1StepStatus(status: string): StepStatus {
  switch (status) {
    case "pending":
    case "running":
    case "waiting_for_human":
    case "hard_stopped":
    case "completed":
    case "failed":
    case "terminated":
      return status;
    case "in_progress":
      return "running";
    case "human_gate_reached":
    case "human_gate":
    case "human_gate_resolved":
      return "waiting_for_human";
    case "hard_stop":
      return "hard_stopped";
    default:
      throw new Error(`Unsupported Phase 1 step status: ${status}`);
  }
}

async function buildPhase1TaskState(input: {
  task: MigrationTask;
  steps: MigrationStepDefinition[];
  decisions: HumanDecision[];
  taskStatePath: string;
}): Promise<Phase1TaskState> {
  const existing = await readJson<Partial<Phase1TaskState> | undefined>(
    input.taskStatePath,
    undefined
  );
  const activeStepId = findCurrentStepId(input.task, input.steps);
  const now = new Date().toISOString();
  const existingSteps = new Map((existing?.steps ?? []).map((step) => [step.id, step]));

  const steps = input.steps.map((step) => {
    const persisted = existingSteps.get(step.id);
    const taskStep = input.task.steps.find((item) => item.id === step.id);
    const status = resolvePhase1StepStatus({ persisted, taskStep, activeStepId });
    return {
      id: step.id,
      name: step.name,
      status,
      summary: persisted?.summary ?? taskStep?.summary,
      artifacts: persisted?.artifacts ?? [],
      completion_decision: persisted?.completion_decision ?? {},
      next_step_context: persisted?.next_step_context ?? {},
      context_debt: persisted?.context_debt ?? []
    };
  });

  return {
    schema_version: 1,
    agent: phase1AgentName,
    mode: "monolithic_driver",
    task_id: input.task.id,
    status: derivePhase1TaskStatus(steps),
    current_step_id: steps.find((step) => step.status !== "completed")?.id ?? activeStepId,
    workflow_path: input.task.workflowPath,
    workspace_path: input.task.workspacePath,
    artifact_path: input.task.artifactPath,
    updated_at: now,
    steps,
    human_decisions: input.decisions,
    claim_boundary: existing?.claim_boundary ?? {
      no_bypass: true,
      source_identical: "unknown",
      runtime_policy: "not_started",
      full_size: "not_claimed",
      gui_acceptance: "not_claimed",
      customer_ready: false
    },
    compaction: {
      running_summary: path.join("artifacts", phase1RunningSummaryFile),
      context_debt: path.join("artifacts", phase1ContextDebtFile),
      phase3_extraction_candidates: path.join("artifacts", phase1ExtractionFile),
      context_budget: path.join("artifacts", phase1ContextBudgetFile),
      step_handoffs: path.join("artifacts", phase1StepHandoffDir),
      compact_checkpoints: path.join("artifacts", phase1ContextDir),
      required_after_each_step: true
    }
  };
}

function resolvePhase1StepStatus(input: {
  persisted?: Phase1StepState;
  taskStep?: MigrationTask["steps"][number];
  activeStepId?: string;
}): string {
  const { persisted, taskStep, activeStepId } = input;
  if (taskStep?.status === "completed" && persisted?.status !== "completed") {
    return "completed";
  }
  if (
    taskStep?.id === activeStepId &&
    taskStep?.status === "pending" &&
    (!persisted?.status || persisted.status === "pending")
  ) {
    return "running";
  }
  if (persisted?.status) return persisted.status;
  return taskStep?.status ?? "pending";
}

function derivePhase1TaskStatus(steps: Array<{ status: string }>): string {
  if (steps.every((step) => step.status === "completed")) return "completed";
  if (steps.some((step) => step.status === "waiting_for_human" || step.status === "human_gate_reached")) {
    return "waiting_for_human";
  }
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.some((step) => step.status === "hard_stopped" || step.status === "hard_stop")) {
    return "hard_stopped";
  }
  if (steps.some((step) => step.status === "terminated")) return "terminated";
  return "running";
}

function compactPhase1StepState(step: Phase1StepState): Phase1StepState {
  return {
    id: step.id,
    name: step.name,
    status: step.status,
    summary: step.summary,
    artifacts: step.artifacts ?? [],
    completion_decision: compactCompletionDecision(step),
    next_step_context: compactNextStepContext(step),
    context_debt: compactContextDebt(step)
  };
}

function compactCompletionDecision(step: Phase1StepState): Record<string, unknown> {
  const decision = step.completion_decision;
  if (!isRecord(decision) || Object.keys(decision).length === 0) return {};

  const compact: Record<string, unknown> = {};
  setString(compact, "status", decision.status);
  setString(compact, "reason", decision.reason, 320);
  setString(compact, "failure_reason", decision.failure_reason, 320);
  setString(compact, "hard_stop_reason", decision.hard_stop_reason, 320);

  const checkedCriteria = compactStringArray(decision.checked_criteria, 4, 140);
  if (checkedCriteria.length > 0) {
    compact.checked_criteria = checkedCriteria;
    compact.checked_criteria_count =
      arrayLength(decision.checked_criteria) || numberValue(decision.checked_criteria_count);
  }

  const evidenceArtifacts = compactStringArray(
    decision.evidence_artifacts ?? decision.evidence,
    8,
    180
  );
  if (evidenceArtifacts.length > 0) compact.evidence_artifacts = evidenceArtifacts;

  const unresolvedGaps = compactStringArray(decision.unresolved_gaps, 6, 180);
  if (unresolvedGaps.length > 0) {
    compact.unresolved_gaps = unresolvedGaps;
    compact.unresolved_gap_count =
      arrayLength(decision.unresolved_gaps) || numberValue(decision.unresolved_gap_count);
  }

  if (typeof decision.next_step_allowed === "boolean") {
    compact.next_step_allowed = decision.next_step_allowed;
  }

  if (isRecord(decision.next_step_recommendation)) {
    compact.next_step_recommendation = compactNextStepRecommendation(
      decision.next_step_recommendation
    );
  }

  const gate = isRecord(decision.human_gate)
    ? decision.human_gate
    : isRecord(decision.human_gate_prompt)
      ? decision.human_gate_prompt
      : undefined;
  if (gate) {
    compact.human_gate = compactHumanGateRecord(gate, step);
  } else if (typeof decision.human_gate_prompt === "string") {
    compact.human_gate_prompt = truncateString(decision.human_gate_prompt, 500);
  }

  compact.detail_ref = phase1StepHandoffRef(step.id);
  return compact;
}

function compactNextStepRecommendation(record: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  setString(compact, "recommended_step_id", record.recommended_step_id, 40);
  setString(compact, "edge_type", record.edge_type, 60);
  setString(compact, "reason", record.reason, 360);
  const requiredContext = compactStringArray(record.required_context_for_next_step, 6, 180);
  if (requiredContext.length > 0) compact.required_context_for_next_step = requiredContext;
  const blockedBy = compactStringArray(record.blocked_by, 6, 180);
  if (blockedBy.length > 0) compact.blocked_by = blockedBy;
  return compact;
}

function compactHumanGateRecord(
  gateRecord: Record<string, unknown>,
  step: Phase1StepState
): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  setString(compact, "question_event_id", gateRecord.question_event_id, 120);
  setString(compact, "problem_summary", gateRecord.problem_summary, 700);
  const decisions = compactAllowedDecisions(gateRecord.allowed_decisions);
  if (decisions.length > 0) compact.allowed_decisions = decisions;
  setString(compact, "claim_boundary_impact", gateRecord.claim_boundary_impact, 600);
  const unresolvedItemCount =
    arrayLength(gateRecord.unresolved_items) || numberValue(gateRecord.unresolved_item_count) || 0;
  if (unresolvedItemCount > 0) compact.unresolved_item_count = unresolvedItemCount;
  const artifactRef = explicitArtifactRef(gateRecord) ?? findStepArtifact(step, "-human-gate.json");
  if (artifactRef) {
    compact.artifact_ref = artifactRef;
    compact.decision_context_ref = artifactRef;
  } else if (isRecord(gateRecord.decision_context)) {
    compact.decision_context = compactDecisionContext(gateRecord.decision_context);
  }
  return compact;
}

function compactAllowedDecisions(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => {
    if (typeof item === "string") return truncateString(item, 180);
    if (!isRecord(item)) return undefined;
    const compact: Record<string, unknown> = {};
    setString(compact, "choice", item.choice, 80);
    setString(compact, "label", item.label, 160);
    setString(compact, "alias_path", item.alias_path, 240);
    setString(compact, "claim_boundary", item.claim_boundary, 240);
    setString(compact, "continuation_edge", item.continuation_edge, 160);
    return Object.keys(compact).length > 0 ? compact : undefined;
  }).filter((item): item is string | Record<string, unknown> => item !== undefined);
}

function compactDecisionContext(record: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  setString(compact, "background_reason_scene", record.background_reason_scene, 700);
  if (Array.isArray(record.terminology)) {
    compact.terminology = record.terminology.slice(0, 4).map((item) => {
      if (!isRecord(item)) return item;
      return {
        term: truncateString(String(item.term ?? ""), 80),
        explanation: truncateString(String(item.explanation ?? ""), 180)
      };
    });
  }
  if (Array.isArray(record.consequences_and_follow_up)) {
    compact.consequences_and_follow_up = record.consequences_and_follow_up
      .slice(0, 4)
      .map((item) => {
        if (!isRecord(item)) return item;
        return {
          choice: truncateString(String(item.choice ?? ""), 100),
          consequence: truncateString(String(item.consequence ?? ""), 220),
          follow_up: truncateString(String(item.follow_up ?? item.followUp ?? ""), 220)
        };
      });
  }
  return compact;
}

function compactNextStepContext(step: Phase1StepState): Record<string, unknown> {
  if (!isRecord(step.next_step_context) || Object.keys(step.next_step_context).length === 0) {
    return {};
  }
  if (JSON.stringify(step.next_step_context).length <= 1000) return step.next_step_context;
  return {
    detail_ref: phase1StepHandoffRef(step.id),
    compacted: true,
    original_keys: Object.keys(step.next_step_context).slice(0, 20)
  };
}

function compactContextDebt(step: Phase1StepState): unknown[] {
  if (!Array.isArray(step.context_debt) || step.context_debt.length === 0) return [];
  return [
    {
      count: step.context_debt.length,
      detail_ref: path.join("artifacts", phase1ContextDebtFile)
    }
  ];
}

function phase1StepHandoffRef(stepId: string): string {
  return path.join("artifacts", phase1StepHandoffDir, `${stepId}-handoff.json`);
}

function findStepArtifact(step: Phase1StepState, suffix: string): string | undefined {
  return step.artifacts?.find(
    (artifact) => artifact.endsWith(`${step.id}${suffix}`) || artifact.endsWith(suffix)
  );
}

function explicitArtifactRef(record: Record<string, unknown>): string | undefined {
  return (
    stringValue(record.artifact_ref) ??
    stringValue(record.detail_ref) ??
    stringValue(record.artifactPath) ??
    stringValue(record.artifact_path)
  );
}

function setString(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  maxLength = 240
): void {
  const text = stringValue(value);
  if (text) target[key] = truncateString(text, maxLength);
}

function compactStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, maxItems)
    .map((item) => truncateString(item, maxLength));
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateString(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findCurrentStepId(
  task: MigrationTask,
  steps: MigrationStepDefinition[]
): string | undefined {
  const active = task.steps.find((step) =>
    ["running", "waiting_for_human", "failed", "hard_stopped", "terminated"].includes(step.status)
  );
  if (active) return active.id;
  return steps.find((step) => {
    const state = task.steps.find((item) => item.id === step.id);
    return !state || state.status !== "completed";
  })?.id;
}

async function ensureRunningSummary(
  filePath: string,
  task: MigrationTask,
  state: Phase1TaskState
): Promise<void> {
  try {
    await fs.access(filePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await fs.writeFile(
    filePath,
    [
      "# Phase 1 running summary",
      "",
      `task_id: \`${task.id}\``,
      `workflow: \`${task.workflowPath}\``,
      `current_step_id: \`${state.current_step_id ?? "none"}\``,
      "",
      "This file is the compact handoff summary for the monolithic Phase 1 agent. Update it after every step before continuing.",
      "",
      "## Current claim boundary",
      "",
      "- no bypass is allowed",
      "- source-identical status is unknown until Step 01 proves or human-bounds it",
      "- full-size, GUI acceptance, and customer-ready claims are not available at startup",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function ensureContextDebt(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJson(filePath, []);
}

async function ensurePhase3Extraction(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJson(filePath, {
    schema_version: 1,
    agent: phase1AgentName,
    candidates: []
  });
}

async function compilePhase1DriverPrompt(input: {
  config: AppConfig;
  task: MigrationTask;
  steps: MigrationStepDefinition[];
  taskState: Phase1TaskState;
  taskStatePath: string;
  runningSummaryPath: string;
  contextDebtPath: string;
  phase3ExtractionPath: string;
  contextBudgetPath: string;
  stepHandoffDir: string;
}): Promise<string> {
  const agentContractPath = path.join(
    input.config.draftDocRoot,
    "migration-workflow-v2",
    "agent.md"
  );
  const stepTable = input.steps
    .map((step) =>
      `- ${step.id} ${step.name}: output=${step.requiredOutput}; prompt=${compactDocPath(
        step.promptPath,
        input.config.draftDocRoot
      )}; skill=${compactDocPath(step.skillPath, input.config.draftDocRoot)}`
    )
    .join("\n");
  const stateSummary = compactTaskStateSummary(input.taskState);

  return [
    "# Phase 1 monolithic backend agent run",
    "",
    "You are the backend-controlled Phase 1 Copilot driver for one ComfyUI Intel XPU migration task. Run Steps 00-13 until completion, human gate, hard stop, or backend/tool failure.",
    "The prompt is intentionally compact. Durable artifacts are the source of truth; read only the current step's required files before doing work.",
    "",
    "## Source-of-truth paths",
    "",
    `- workflow: ${input.task.workflowPath}`,
    `- workspace: ${input.task.workspacePath}`,
    `- artifacts: ${input.task.artifactPath}`,
    `- task state: ${input.taskStatePath}`,
    `- running summary: ${input.runningSummaryPath}`,
    `- context debt: ${input.contextDebtPath}`,
    `- Phase 3 extraction candidates: ${input.phase3ExtractionPath}`,
    `- context budget monitor: ${input.contextBudgetPath}`,
    `- step handoff dir: ${input.stepHandoffDir}`,
    `- full agent contract: ${agentContractPath}`,
    `- ComfyUI root: ${input.config.comfyuiRoot}`,
    `- model roots: ${input.config.modelRoots.join(", ") || "(none)"}`,
    "",
    "## Required operating loop",
    "",
    "1. Read `task-state.json` and `running-summary.md`; use the compact state below only as a startup hint.",
    "2. Pick `current_step_id` or the first non-completed step. If it is `waiting_for_human`, inspect `human_decisions` and continue only when the decision is sufficient and safe.",
    "3. Read the current step's prompt and skill document from the step map. Do not preload every step document.",
    "4. Read only required predecessor artifacts and the current step handoff/context debt. Use targeted `jq`, `grep`, `head`, or small scripts for large files.",
    "5. Check `context-budget.json` at step boundaries. On warning: write compact checkpoint before the next step. On critical: do not start a new step; stop with checkpoint summary for backend resume.",
    "6. After each step, write full completion/gate details to `step-handoffs/{step}-handoff.json` and any step-specific gate/report artifacts; keep `task-state.json` as a compact ledger with statuses, short summary, artifact refs, compact next-step recommendation, gate id/choices/claim impact, and detail refs only.",
    "7. Then update `running-summary.md`, `context-debt.json`, `phase3-extraction-candidates.json`, and required step artifacts before moving on.",
    "",
    "## Non-negotiable compact contract",
    "",
    "- No bypass: never delete, disable, mute, collapse, rewire, or semantically replace workflow nodes to force success.",
    "- Do not edit the source workflow in place. Runtime-policy variants must be separate artifacts with explicit diffs.",
    "- Source-identical assets are required unless a human explicitly approves named substitutes/aliases and the claim boundary is downgraded.",
    "- Do not claim source-identical, full-size, GUI/manual accepted, customer-ready, or unrestricted success without matching evidence.",
    "- Do not persist credentials, tokens, cookies, private keys, passwords, private URLs with secrets, or private connection strings.",
    "- Artifact existence is not completion. A step is complete only when schema/status/evidence support the next safe step.",
    "- `task-state.json` is a compact state index, not the place for long evidence dumps. Detailed `completion_decision`, human-gate background, unresolved item lists, terminology, and consequences must live in artifacts referenced from task-state.",
    "- **Never collapse step objects to strings.** Every entry in the `steps` array must remain a full object with `id`, `name`, `status`, `artifacts`, `completion_decision`, `next_step_context`, and `context_debt` fields. Replacing a step object with a bare `\"00\"` string will break the backend.",
    "- Every step must end with `completion_decision`, human gate, or hard stop. Include checked criteria, evidence artifacts, unresolved gaps, `next_step_allowed`, and `next_step_recommendation`.",
    "- **Unresolved gaps require a human gate, not `next_step_allowed: true`.** If **any** asset (input image, model, LoRA, VAE, custom node, or other dependency) cannot be found, downloaded, or aliased after the step's search/download effort, the step MUST end with `status: human_gate` — never `completed`. Write a full human-gate artifact (`artifacts/{step}-human-gate.json`), reference it from `completion_decision`, and list every unresolved item with its exact filename, kind, and source-node ids. Skipping or deferring a missing asset without a human gate is forbidden.",
    "- Every executed step must write `{step}-reflection.md` and `{step}-reflection.json`, plus update Phase 3 extraction candidates. If chat memory was needed, add matching `context-debt.json` entries.",
    "- Human gates must be Web-visible and name the exact step, blocker, choices, consequences/follow-up, continuation edge, and claim-boundary impact.",
    "- Hard stop when safe continuation would require unavailable source-identical assets without approval, semantic graph changes, persisted secrets, out-of-scope feature work, proven capacity impossibility without approved reduction, or unrecoverable missing upstream context.",
    "- Never paste full large artifacts, workflow JSON, SDK transcripts, model listings, or long command output into responses/summaries. Store paths and summarize counts, statuses, checksums, and blockers.",
    "- Step 13 is mandatory after Step 12 unless gated or hard-stopped. Shared prompt/skill/backend changes from Step 13 require explicit human approval.",
    "",
    "## Compact task-state hint",
    "",
    ...stateSummary,
    "",
    "## Step document map",
    "",
    stepTable,
    "",
    "## Final instruction",
    "",
    "Proceed now. Do not ask whether to start. Stop only for a valid human gate, hard stop, backend/tool failure, context-budget checkpoint, or completion of Step 13. If a rule is ambiguous, read the relevant section of the full agent contract by path instead of loading unrelated large content."
  ].join("\n");
}

function compactDocPath(filePath: string | undefined, draftDocRoot: string): string {
  if (!filePath) return "none";
  const relative = path.relative(draftDocRoot, filePath);
  return relative.startsWith("..") ? filePath : relative;
}

function compactTaskStateSummary(state: Phase1TaskState): string[] {
  const byStatus = new Map<string, string[]>();
  for (const step of state.steps) {
    byStatus.set(step.status, [...(byStatus.get(step.status) ?? []), step.id]);
  }
  const statusLines = [...byStatus.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, ids]) => `- ${status}: ${ids.join(", ")}`);
  const current = state.steps.find((step) => step.id === state.current_step_id);
  return [
    `- task_id: ${state.task_id}`,
    `- phase1_status: ${state.status}`,
    `- current_step_id: ${state.current_step_id ?? "none"}${current?.name ? ` (${current.name})` : ""}`,
    `- human_decisions: ${state.human_decisions.length}`,
    `- claim_boundary: ${JSON.stringify(state.claim_boundary)}`,
    ...statusLines
  ];
}
