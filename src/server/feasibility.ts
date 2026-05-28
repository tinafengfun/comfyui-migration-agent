import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationTask } from "../shared/types";

export interface FeasibilityResult {
  artifactPath: string;
  gated: boolean;
  criticalGapCount: number;
}

export async function ensureFeasibility(input: {
  task: MigrationTask;
  modelRoots: string[];
  stepId?: string;
}): Promise<FeasibilityResult> {
  const stepId = input.stepId ?? "02";
  const intakePath = path.join(input.task.artifactPath, "00-intake-preflight.md");
  const intake = await fs.readFile(intakePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const missingModels = extractList(intake, "Missing source-identical models");
  const aliasCandidates = extractList(intake, "Alias/smoke candidates requiring approval");
  // Only gate on actual missing assets, not on intake prose keywords.
  // Step 01 may have resolved all gaps; gating must reflect current state.
  const gated = missingModels.length > 0 || aliasCandidates.length > 0;
  const artifactPath = path.join(input.task.artifactPath, `${stepId}-feasibility.md`);
  await fs.writeFile(
    artifactPath,
    feasibilityMarkdown({
      task: input.task,
      modelRoots: input.modelRoots,
      stepId,
      gated,
      missingModels,
      aliasCandidates
    }),
    "utf8"
  );
  // Write structured gate-signal.json instead of embedding gate status in artifact text
  if (gated) {
    const gateSignalPath = path.join(input.task.artifactPath, `${stepId}-gate-signal.json`);
    await fs.writeFile(
      gateSignalPath,
      JSON.stringify({
        stepId,
        gated: true,
        category: "missing_asset",
        trigger: "deterministic",
        reason: `Step ${stepId} feasibility precheck found ${missingModels.length} missing model(s) and ${aliasCandidates.length} alias candidate(s) requiring human decision.`,
        items: [
          ...missingModels.map((m) => ({ asset: m, state: "source unknown", needsHumanAction: "provide source-identical asset" })),
          ...aliasCandidates.map((a) => ({ asset: a, state: "alias available", needsHumanAction: "approve or reject alias" }))
        ]
      }, null, 2),
      "utf8"
    );
  }
  return {
    artifactPath,
    gated,
    criticalGapCount: missingModels.length
  };
}

function feasibilityMarkdown(input: {
  task: MigrationTask;
  modelRoots: string[];
  stepId: string;
  gated: boolean;
  missingModels: string[];
  aliasCandidates: string[];
}): string {
  return [
    `# Step ${input.stepId} Feasibility Analysis`,
    "",
    "## Status",
    input.gated
      ? "Feasibility precheck found unresolved asset gaps. The source workflow was not modified and no workflow nodes were bypassed, deleted, collapsed, replaced, installed, or executed."
      : "Feasibility precheck completed without source-identical asset blockers detected by Step 00.",
    "",
    "## Scope and prior evidence",
    `- Task ID: \`${input.task.id}\``,
    `- Workflow: \`${input.task.workflowPath}\``,
    `- Artifact folder: \`${input.task.artifactPath}\``,
    `- Model roots checked: ${input.modelRoots.map((root) => `\`${root}\``).join(", ") || "(none)"}`,
    "- Prior artifact used: `00-intake-preflight.md`",
    "- Constraint: no bypass, no node deletion/replacement, no source workflow mutation.",
    "",
    "## Initial feasibility class",
    input.gated
      ? "Initial class: **blocked for normal migration; bounded smoke-only follow-up requires explicit human approval and must retain documented gaps**."
      : "Initial class: **can continue to workflow inventory and source audit**.",
    "",
    "## Critical source-identical asset gaps",
    "",
    table(input.missingModels, "No critical missing model names were detected in Step 00."),
    "",
    "## Alias or smoke-only candidates requiring approval",
    "",
    table(input.aliasCandidates, "No alias candidates were detected in Step 00."),
    "",
    "## Human gates",
    input.gated
      ? [
          "- Human decision required before runtime, install, or migration work.",
          "- Provide exact source-identical models, or approve a bounded smoke-only/reduced-resource validation path.",
          "- Any smoke-only continuation must not be represented as source-identical migration success."
        ].join("\n")
      : `- No Step ${input.stepId} human gate triggered by deterministic feasibility precheck.`,
    "",
    "## Next recommended step",
    input.gated
      ? "Stop for human input. If the operator approves documented gaps, continue to workflow inventory and preserve the no-bypass boundary."
      : "Continue to workflow inventory.",
    ""
  ].join("\n");
}

function table(items: string[], empty: string): string {
  if (items.length === 0) return empty;
  return ["| Item |", "| --- |", ...items.map((item) => `| ${item.replace(/\|/g, "\\|")} |`)].join("\n");
}

function extractList(content: string, heading: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => normalizeHeading(line) === normalizeHeading(heading));
  if (start === -1) return [];
  const result: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+/.test(line)) break;
    const match = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (match) result.push(match[1]);
  }
  return result;
}

function normalizeHeading(value: string): string {
  return value.replace(/^#+\s*/, "").trim().toLowerCase();
}
