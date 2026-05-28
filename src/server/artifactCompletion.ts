import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationStepDefinition, MigrationTask } from "../shared/types";

export interface ArtifactCompletionResult {
  complete: boolean;
  matchedPath?: string;
  reason: string;
}

export interface ArtifactGateResult {
  gated: boolean;
  matchedPath?: string;
  reason: string;
}

export async function checkRequiredArtifactCompletion(
  task: MigrationTask,
  step: MigrationStepDefinition,
  options?: { skipScaffoldCheck?: boolean }
): Promise<ArtifactCompletionResult> {
  const groups = expectedArtifactGroups(step);
  if (groups.length === 0) {
    return { complete: false, reason: `No concrete artifact candidate for ${step.requiredOutput}` };
  }

  const missingByGroup: string[] = [];
  for (const group of groups) {
    const missing: string[] = [];
    for (const candidate of group) {
      if (!(await isReadableNonEmptyFile(path.join(task.artifactPath, candidate), options?.skipScaffoldCheck))) {
        missing.push(candidate);
      }
    }
    if (missing.length === 0) {
      return {
        complete: true,
        matchedPath: group.length === 1 ? path.join(task.artifactPath, group[0]) : task.artifactPath,
        reason:
          step.id === "13"
            ? `All Step 13 self-evolution artifacts exist and are non-empty: ${group.join(", ")}`
            : group.length === 1
              ? `Required artifact exists and is non-empty: ${group[0]}`
              : `All required artifact group members exist and are non-empty: ${group.join(", ")}`
      };
    }
    missingByGroup.push(`${group.join(" + ")} missing ${missing.join(", ")}`);
  }

  return {
    complete: false,
    reason: `No required artifact group is complete: ${missingByGroup.join("; ")}`
  };
}

export async function checkRequiredArtifactGate(
  task: MigrationTask,
  step: MigrationStepDefinition
): Promise<ArtifactGateResult> {
  // Only trust structured gate-signal.json written by deterministic code.
  // LLM-written gate markers in artifact text are no longer recognized.
  const signalResult = await checkGateSignal(task, step);
  if (signalResult) return signalResult;

  return { gated: false, reason: "No gate-signal.json found for this step" };
}

export function expectedArtifactCandidates(step: MigrationStepDefinition): string[] {
  return [...new Set(expectedArtifactGroups(step).flat())];
}

export function expectedArtifactGroups(step: MigrationStepDefinition): string[][] {
  switch (step.id) {
    case "00":
      return [["00-intake-preflight.md"]];
    case "01":
      return stepMentionsOnlyOneRequiredArtifact(step, ["01-assets.csv", "01-custom-nodes.md"]) ?? [
        ["01-assets.csv", "01-custom-nodes.md"]
      ];
    case "02":
      return [["02-feasibility.md"]];
    case "03":
      return [["03-inventory.md"], ["03-workflow-topology.md", "03-node-inventory.csv"]];
    case "04":
      return [["04-source-audit.md"]];
    case "05":
      return [["05-environment.md"]];
    case "06":
      return stepMentionsOnlyOneRequiredArtifact(step, ["06-prompt-validation.json", "06-prompt.json"]) ?? [
        ["06-prompt-validation.json", "06-prompt.json"],
        ["06-prompt-validation-summary.json", "06-source-preserving-prompt.json"]
      ];
    case "07":
      return [["07-first-stage-smoke.md"], ["07-branch-1-smoke.md"], ["07-branch-smoke.md"], ["07-branch-smoke-summary.json"]];
    case "08":
      return [["08-full-validation.md"], ["08-full-validation-report.md"]];
    case "09":
      return [["09-tuning.md"]];
    case "10":
      return [["10-coverage-review.md"]];
    case "11":
      return [["11-delivery.md"], ["migration-result-report.md"]];
    case "12":
      return [["12-gui-acceptance.md"]];
    case "13":
      return [
        [
          "13-agent-improvement.json",
          "13-agent-improvement.md",
          "13-playbook-patch-plan.md",
          "13-phase3-readiness.json",
          "13-reflection.md",
          "13-reflection.json"
        ]
      ];
    default:
      return [];
  }
}

async function isReadableNonEmptyFile(filePath: string, skipScaffoldCheck?: boolean): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) return false;
    if (!skipScaffoldCheck && stat.size <= 1024 * 1024) {
      const content = await fs.readFile(filePath, "utf8");
      if (isInProgressScaffold(content)) return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isInProgressScaffold(content: string): boolean {
  return /["']?orchestrator_status["']?\s*[:=]\s*["']?in_progress/i.test(content);
}

/**
 * Check for a structured gate-signal.json written by deterministic code.
 * This is the sole authoritative gate source — LLM-written gate markers in artifact
 * text are no longer recognized.
 */
async function checkGateSignal(
  task: MigrationTask,
  step: MigrationStepDefinition
): Promise<ArtifactGateResult | undefined> {
  const signalPath = path.join(task.artifactPath, `${step.id}-gate-signal.json`);
  try {
    const stat = await fs.stat(signalPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 64 * 1024) return undefined;
    const content = await fs.readFile(signalPath, "utf8");
    const signal = JSON.parse(content) as {
      stepId?: string;
      gated?: boolean;
      category?: string;
      trigger?: string;
      items?: Array<{ asset?: string; state?: string; needsHumanAction?: string }>;
      reason?: string;
    };
    if (signal.gated !== true) return undefined;
    const reason = signal.reason ??
      `Step ${step.id} gate (${signal.category ?? "unknown"}): ${signal.items?.map((i) => i.asset ?? i.needsHumanAction).join(", ") ?? "see gate-signal.json"}`;
    return {
      gated: true,
      matchedPath: signalPath,
      reason
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Invalid JSON or other error — fall through to legacy check
    return undefined;
  }
}

function stepMentionsOnlyOneRequiredArtifact(
  step: MigrationStepDefinition,
  artifacts: string[]
): string[][] | undefined {
  const mentioned = artifacts.filter((artifact) =>
    step.requiredOutput.toLowerCase().includes(artifact.toLowerCase())
  );
  if (mentioned.length === 1) return [[mentioned[0]]];
  return undefined;
}
