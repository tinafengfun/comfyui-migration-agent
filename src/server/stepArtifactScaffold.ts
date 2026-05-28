import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationStepDefinition, MigrationTask } from "../shared/types";
import { expectedArtifactCandidates } from "./artifactCompletion";

export interface StepArtifactScaffoldResult {
  created: boolean;
  path?: string;
  relativePath?: string;
  reason: string;
}

export async function ensureStepArtifactScaffold(
  task: MigrationTask,
  step: MigrationStepDefinition
): Promise<StepArtifactScaffoldResult> {
  const candidate = selectScaffoldCandidate(step);
  if (!candidate) {
    return { created: false, reason: `No scaffold candidate for Step ${step.id}` };
  }

  const filePath = path.join(task.artifactPath, candidate);
  if (await isNonEmpty(filePath)) {
    return {
      created: false,
      path: filePath,
      relativePath: path.relative(task.workspacePath, filePath),
      reason: `${candidate} already exists`
    };
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, scaffoldContent(task, step, candidate), "utf8");
  return {
    created: true,
    path: filePath,
    relativePath: path.relative(task.workspacePath, filePath),
    reason: `Created in-progress scaffold ${candidate}`
  };
}

export function isInProgressScaffold(content: string): boolean {
  return /["']?orchestrator_status["']?\s*[:=]\s*["']?in_progress/i.test(content);
}

function selectScaffoldCandidate(step: MigrationStepDefinition): string | undefined {
  const candidates = expectedArtifactCandidates(step);
  return (
    candidates.find((candidate) => candidate.endsWith(".md")) ??
    candidates.find((candidate) => candidate.endsWith(".json")) ??
    candidates[0]
  );
}

function scaffoldContent(
  task: MigrationTask,
  step: MigrationStepDefinition,
  candidate: string
): string {
  if (candidate.endsWith(".json")) {
    return `${JSON.stringify(
      {
        orchestrator_status: "in_progress",
        step_id: step.id,
        step_name: step.name,
        task_id: task.id,
        workflow: task.workflowPath,
        artifact_folder: task.artifactPath,
        note: "Backend scaffold only. The SDK or deterministic step must replace this with complete evidence before the step can complete."
      },
      null,
      2
    )}\n`;
  }

  if (candidate.endsWith(".csv")) {
    return [
      "orchestrator_status,step_id,step_name,note",
      `in_progress,${csv(step.id)},${csv(step.name)},${csv("Backend scaffold only; replace with complete evidence before the step can complete.")}`,
      ""
    ].join("\n");
  }

  return [
    `# ${step.id} - ${step.name}`,
    "",
    "orchestrator_status: in_progress",
    "",
    `task_id: \`${task.id}\``,
    `workflow: \`${task.workflowPath}\``,
    `artifact_folder: \`${task.artifactPath}\``,
    "",
    "## Status",
    "",
    "Backend scaffold only. This file exists so the web UI has immediate, durable step context. The SDK or deterministic step must replace this marker with complete evidence before the step can complete.",
    "",
    "## Expected output",
    "",
    `- \`${step.requiredOutput}\``,
    "",
    "## Human gate",
    "",
    step.humanIntervention || "none",
    ""
  ].join("\n");
}

function csv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function isNonEmpty(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
