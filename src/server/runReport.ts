import fs from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, MigrationTask } from "../shared/types";

export interface StepReport {
  stepId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  durationMs: number | null;
  gateTriggered: boolean;
  gateReason: string;
  autoApproved: boolean;
  autoApprovedFrom: string;
  humanDecision: { answer: string; decidedAt: string } | null;
  artifactsWritten: string[];
  problems: StepProblem[];
}

export interface StepProblem {
  type: "false_gate" | "stale_gate" | "overwrite_conflict" | "scaffold_mismatch" | "new_gap" | "sdk_timeout" | "other";
  detail: string;
  artifact?: string;
}

export interface RunMetrics {
  stepsCompleted: number;
  stepsFailed: number;
  totalGates: number;
  humanGates: number;
  autoApprovedGates: number;
  falseGates: number;
  totalDurationMs: number | null;
}

export interface RunReport {
  runId: string;
  workflowFile: string;
  startedAt: string;
  completedAt: string;
  status: string;
  steps: StepReport[];
  metrics: RunMetrics;
}

interface StoredDecision {
  taskId: string;
  stepId?: string;
  questionEventId: string;
  answer: string;
  wasFreeform: boolean;
  decidedAt: string;
}

type EventData = Record<string, unknown>;

function eventData(e: AgentEvent): EventData {
  if (e.data != null && typeof e.data === "object" && !Array.isArray(e.data)) {
    return e.data as EventData;
  }
  return {};
}

export async function generateRunReport(input: {
  task: MigrationTask;
  decisions: StoredDecision[];
  events: AgentEvent[];
  workflowSha256?: string;
}): Promise<RunReport> {
  const { task, decisions } = input;
  const events = input.events;
  const steps: StepReport[] = [];
  const decisionMap = new Map<string, StoredDecision>();
  for (const d of decisions) {
    if (d.stepId) decisionMap.set(d.stepId, d);
  }

  for (const stepState of task.steps) {
    const stepEvents = events.filter((e) => e.stepId === stepState.id);
    const stepReport = buildStepReport(stepState, stepEvents, decisionMap.get(stepState.id));
    steps.push(stepReport);
  }

  // Detect false gates: auto-approved gates are false gates (they shouldn't have been triggered)
  for (const step of steps) {
    if (step.autoApproved) {
      step.problems.push({
        type: "false_gate",
        detail: `Gate auto-approved from prior Step ${step.autoApprovedFrom}. This gate should not have been triggered.`
      });
    }
  }

  const metrics = computeMetrics(steps, task);
  const workflowFile = path.basename(task.workflowPath);

  const report: RunReport = {
    runId: task.id,
    workflowFile,
    startedAt: task.createdAt,
    completedAt: task.updatedAt,
    status: task.status,
    steps,
    metrics
  };

  // Write to artifact folder
  const reportPath = path.join(task.artifactPath, "run-report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  return report;
}

function buildStepReport(
  stepState: { id: string; status: string; startedAt?: string; completedAt?: string; summary?: string; error?: string },
  stepEvents: AgentEvent[],
  decision?: StoredDecision
): StepReport {
  // Find gate events
  const humanQuestionEvent = stepEvents.find((e) => e.type === "human_question");
  const autoApproveEvent = stepEvents.find((e) => {
    const d = eventData(e);
    return e.type === "progress" && d.autoApproved === true;
  });

  // Find artifacts written
  const artifactEvents = stepEvents.filter((e) => e.type === "artifact_created");
  const artifactsWritten = artifactEvents
    .map((e) => {
      const d = eventData(e);
      const p = (d.path as string) ?? (d.relativePath as string) ?? "";
      return path.basename(p);
    })
    .filter(Boolean);

  const gateTriggered = humanQuestionEvent != null || autoApproveEvent != null;
  const autoData = autoApproveEvent ? eventData(autoApproveEvent) : {};
  const humanData = humanQuestionEvent ? eventData(humanQuestionEvent) : {};
  const gateReason = (humanData.question as string) ??
    (autoData.currentGateReason as string) ??
    "";

  const durationMs = computeDuration(stepState.startedAt, stepState.completedAt);

  return {
    stepId: stepState.id,
    status: stepState.status,
    startedAt: stepState.startedAt,
    completedAt: stepState.completedAt,
    durationMs,
    gateTriggered,
    gateReason: gateReason.slice(0, 300),
    autoApproved: autoApproveEvent != null,
    autoApprovedFrom: (autoData.priorStepId as string) ?? "",
    humanDecision: decision
      ? { answer: decision.answer, decidedAt: decision.decidedAt }
      : null,
    artifactsWritten: [...new Set(artifactsWritten)],
    problems: []
  };
}

function computeDuration(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return isNaN(ms) ? null : ms;
}

function computeMetrics(steps: StepReport[], task: MigrationTask): RunMetrics {
  const totalGates = steps.filter((s) => s.gateTriggered).length;
  const autoApprovedGates = steps.filter((s) => s.autoApproved).length;
  const humanGates = steps.filter((s) => s.gateTriggered && !s.autoApproved && s.humanDecision).length;
  const falseGates = steps.reduce((sum, s) => sum + s.problems.filter((p) => p.type === "false_gate").length, 0);

  let totalDurationMs: number | null = null;
  const start = task.createdAt;
  const end = task.updatedAt;
  if (start && end) {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!isNaN(ms)) totalDurationMs = ms;
  }

  return {
    stepsCompleted: steps.filter((s) => s.status === "completed").length,
    stepsFailed: steps.filter((s) => s.status === "failed").length,
    totalGates,
    humanGates,
    autoApprovedGates,
    falseGates,
    totalDurationMs
  };
}
