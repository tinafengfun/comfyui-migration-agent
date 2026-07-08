import type { RunReport, StepReport, RunMetrics } from "./runReport";

/**
 * Layer 2: LLM-compatible run-report analyzer.
 *
 * Reads run-report.json and produces a structured improvement proposal
 * that can be consumed by Step 13 or reviewed by a human operator.
 *
 * This module does NOT call an LLM itself — it produces a structured
 * analysis payload that an LLM agent can use to propose code changes.
 */

export interface EvolutionAnalysis {
  sourceRunId: string;
  sourceWorkflow: string;
  analyzedAt: string;
  summary: string;
  problemPatterns: ProblemPattern[];
  improvementProposals: ImprovementProposal[];
  metricsSnapshot: RunMetrics;
}

export interface ProblemPattern {
  id: string;
  type: ProblemType;
  severity: "critical" | "high" | "medium" | "low";
  affectedSteps: string[];
  description: string;
  rootCause: string;
  evidence: string[];
}

export type ProblemType =
  | "false_gate"
  | "timeout"
  | "slow_step"
  | "missing_artifact"
  | "repeated_failure"
  | "gate_without_blocker"
  | "sdk_session_error"
  | "human_gate_bottleneck";

export interface ImprovementProposal {
  id: string;
  targetArea: "deterministic_code" | "prompt_skill" | "sdk_config" | "pipeline_flow";
  targetFiles: string[];
  problemPatternIds: string[];
  description: string;
  suggestedChange: string;
  expectedEffect: string;
  risk: "low" | "medium" | "high";
}

export function analyzeRunReport(report: RunReport): EvolutionAnalysis {
  const patterns = detectPatterns(report);
  const proposals = generateProposals(report, patterns);

  return {
    sourceRunId: report.runId,
    sourceWorkflow: report.workflowFile,
    analyzedAt: new Date().toISOString(),
    summary: buildSummary(report, patterns),
    problemPatterns: patterns,
    improvementProposals: proposals,
    metricsSnapshot: report.metrics
  };
}

// ── Pattern Detection ──────────────────────────────────────────────

function detectPatterns(report: RunReport): ProblemPattern[] {
  const patterns: ProblemPattern[] = [];

  // Pattern: False gates (auto-approved gates that shouldn't exist)
  const falseGateSteps = report.steps.filter(
    (s) => s.problems.some((p) => p.type === "false_gate")
  );
  if (falseGateSteps.length > 0) {
    patterns.push({
      id: "p-false-gates",
      type: "false_gate",
      severity: "high",
      affectedSteps: falseGateSteps.map((s) => s.stepId),
      description: `${falseGateSteps.length} steps triggered gates that were auto-approved from prior decisions. These gates should not have been triggered.`,
      rootCause: inferFalseGateRootCause(falseGateSteps, report),
      evidence: falseGateSteps.map(
        (s) => `Step ${s.stepId}: gateReason="${s.gateReason.slice(0, 100)}" autoApprovedFrom=${s.autoApprovedFrom}`
      )
    });
  }

  // Pattern: Gate without real blocker (gate triggered but no missing assets)
  const gateNoBlockerSteps = report.steps.filter(
    (s) =>
      s.gateTriggered &&
      !s.autoApproved &&
      s.humanDecision &&
      !s.gateReason.toLowerCase().includes("missing") &&
      !s.gateReason.toLowerCase().includes("gap")
  );
  if (gateNoBlockerSteps.length > 0) {
    patterns.push({
      id: "p-gate-no-blocker",
      type: "gate_without_blocker",
      severity: "medium",
      affectedSteps: gateNoBlockerSteps.map((s) => s.stepId),
      description: `${gateNoBlockerSteps.length} steps gated without a clear blocker. Gate reasons don't mention missing assets or gaps.`,
      rootCause: "Gate detection may be triggered by LLM prose (e.g., 'human gate' keywords) rather than actual blockers.",
      evidence: gateNoBlockerSteps.map(
        (s) => `Step ${s.stepId}: gateReason="${s.gateReason.slice(0, 120)}"`
      )
    });
  }

  // Pattern: Slow steps (>10 min)
  const slowSteps = report.steps.filter(
    (s) => s.durationMs !== null && s.durationMs > 10 * 60 * 1000
  );
  if (slowSteps.length > 0) {
    patterns.push({
      id: "p-slow-steps",
      type: "slow_step",
      severity: "medium",
      affectedSteps: slowSteps.map((s) => s.stepId),
      description: `${slowSteps.length} steps took longer than 10 minutes. This may indicate SDK session inefficiency or LLM looping.`,
      rootCause: "SDK agent may be exploring too broadly or retrying failed operations.",
      evidence: slowSteps.map(
        (s) => `Step ${s.stepId}: ${Math.round((s.durationMs ?? 0) / 60000)}min`
      )
    });
  }

  // Pattern: Failed steps
  const failedSteps = report.steps.filter((s) => s.status === "failed");
  if (failedSteps.length > 0) {
    patterns.push({
      id: "p-failed-steps",
      type: "repeated_failure",
      severity: "critical",
      affectedSteps: failedSteps.map((s) => s.stepId),
      description: `${failedSteps.length} steps failed. Pipeline did not complete successfully.`,
      rootCause: failedSteps
        .map((s) => {
          const err = s.problems[0]?.detail ?? "unknown error";
          return `Step ${s.stepId}: ${err.slice(0, 100)}`;
        })
        .join("; "),
      evidence: failedSteps.map(
        (s) => `Step ${s.stepId}: status=${s.status} error=${(s.problems[0]?.detail ?? "unknown").slice(0, 120)}`
      )
    });
  }

  // Pattern: Human gate bottleneck (many gates requiring human intervention)
  if (report.metrics.humanGates > 2) {
    const humanGateSteps = report.steps.filter(
      (s) => s.gateTriggered && !s.autoApproved && s.humanDecision
    );
    patterns.push({
      id: "p-human-bottleneck",
      type: "human_gate_bottleneck",
      severity: "high",
      affectedSteps: humanGateSteps.map((s) => s.stepId),
      description: `${report.metrics.humanGates} human gates required intervention. Consider adding decision propagation or auto-approval rules.`,
      rootCause: "Insufficient decision propagation or missing auto-approval categories.",
      evidence: humanGateSteps.map(
        (s) => `Step ${s.stepId}: answer="${s.humanDecision?.answer?.slice(0, 60) ?? "?"}"`
      )
    });
  }

  // Pattern: Steps with no artifacts written
  const noArtifactSteps = report.steps.filter(
    (s) => s.status === "completed" && s.artifactsWritten.length === 0 && s.stepId !== "00"
  );
  if (noArtifactSteps.length > 0) {
    patterns.push({
      id: "p-missing-artifacts",
      type: "missing_artifact",
      severity: "medium",
      affectedSteps: noArtifactSteps.map((s) => s.stepId),
      description: `${noArtifactSteps.length} completed steps wrote no artifacts. Expected artifacts may be missing.`,
      rootCause: "SDK agent may have written artifacts under unexpected filenames or skipped required outputs.",
      evidence: noArtifactSteps.map((s) => `Step ${s.stepId}: completed but artifactsWritten=[]`)
    });
  }

  return patterns;
}

// ── Root Cause Inference ────────────────────────────────────────────

function inferFalseGateRootCause(steps: StepReport[], report: RunReport): string {
  const gateReasons = steps.map((s) => s.gateReason.toLowerCase());

  if (gateReasons.some((r) => r.includes("human_gate_reached") || r.includes("orchestrator_status"))) {
    return "LLM wrote 'human_gate_reached' or 'orchestrator_status' in artifact text, which was picked up by regex-based gate detection.";
  }
  if (gateReasons.some((r) => r.includes("human decision") || r.includes("human gate"))) {
    return "LLM included 'human gate' or 'human decision' keywords in artifact prose, triggering text-based gate detection.";
  }
  if (gateReasons.some((r) => r.includes("gate-signal.json"))) {
    return "Deterministic code wrote gate-signal.json incorrectly — gate triggered without a real blocker.";
  }
  return "Unknown root cause for false gates. Manual inspection of gate reasons recommended.";
}

// ── Proposal Generation ─────────────────────────────────────────────

function generateProposals(report: RunReport, patterns: ProblemPattern[]): ImprovementProposal[] {
  const proposals: ImprovementProposal[] = [];

  for (const pattern of patterns) {
    switch (pattern.type) {
      case "false_gate":
        proposals.push({
          id: `fix-${pattern.id}`,
          targetArea: "deterministic_code",
          targetFiles: ["src/server/artifactCompletion.ts"],
          problemPatternIds: [pattern.id],
          description: "Ensure gate detection only trusts structured gate-signal.json files, not LLM-written text markers.",
          suggestedChange:
            "In checkRequiredArtifactGate, remove the regex-based readGateReason fallback. Only check gate-signal.json written by deterministic code. Also update prompt/skill files to instruct the LLM not to write gate keywords in artifacts.",
          expectedEffect: `Eliminate ${pattern.affectedSteps.length} false gates across steps ${pattern.affectedSteps.join(", ")}.`,
          risk: "low"
        });
        break;

      case "gate_without_blocker":
        proposals.push({
          id: `fix-${pattern.id}`,
          targetArea: "deterministic_code",
          targetFiles: ["src/server/artifactCompletion.ts", "src/server/feasibility.ts"],
          problemPatternIds: [pattern.id],
          description: "Review gate-signal.json generation logic to ensure gates are only triggered when genuine blockers exist.",
          suggestedChange:
            "In feasibility.ts, only set gated=true when there are actual missing models or unresolved aliases (not just when can_continue_to_feasibility is 'no' due to input media). In checkGateSignal, validate that the gate items array is non-empty.",
          expectedEffect: `Reduce unnecessary gates from ${pattern.affectedSteps.length} to 0 for workflows without real asset gaps.`,
          risk: "medium"
        });
        break;

      case "slow_step":
        proposals.push({
          id: `fix-${pattern.id}`,
          targetArea: "prompt_skill",
          targetFiles: getPromptFilesForSteps(pattern.affectedSteps),
          problemPatternIds: [pattern.id],
          description: "Optimize SDK agent prompts for slow steps to reduce exploration scope and improve focus.",
          suggestedChange:
            "Add explicit scoping constraints to the step prompt: 'Focus on the specific task. Do not expand exploration beyond what is needed for this step. Use prior artifacts as primary evidence.' Consider adding a token budget warning.",
          expectedEffect: `Reduce step duration by 30-50% for steps ${pattern.affectedSteps.join(", ")}.`,
          risk: "medium"
        });
        break;

      case "human_gate_bottleneck":
        proposals.push({
          id: `fix-${pattern.id}`,
          targetArea: "deterministic_code",
          targetFiles: ["src/server/orchestrator.ts"],
          problemPatternIds: [pattern.id],
          description: "Expand decision propagation to cover more gate categories and enable cross-step auto-approval.",
          suggestedChange:
            "In pauseIfArtifactHumanGate, expand isAutoApprovableCategory to include more blocking reasons. In findPriorContinueApproval, also match on similar gate reason text, not just blocking category.",
          expectedEffect: `Reduce human gates from ${report.metrics.humanGates} to 1 (first gate only).`,
          risk: "low"
        });
        break;

      case "repeated_failure":
        proposals.push({
          id: `fix-${pattern.id}`,
          targetArea: "sdk_config",
          targetFiles: ["src/server/copilotSdkRunner.ts"],
          problemPatternIds: [pattern.id],
          description: "Investigate step failures and add retry/recovery logic for transient SDK errors.",
          suggestedChange:
            "Add configurable retry for SDK session errors (timeout, rate limit). Implement step-level checkpoint so failed steps can resume from last known good state instead of restarting from scratch.",
          expectedEffect: `Improve pipeline completion rate from ${report.metrics.stepsCompleted}/14.`,
          risk: "high"
        });
        break;

      case "missing_artifact":
        proposals.push({
          id: `fix-${pattern.id}`,
          targetArea: "prompt_skill",
          targetFiles: getPromptFilesForSteps(pattern.affectedSteps),
          problemPatternIds: [pattern.id],
          description: "Strengthen artifact naming requirements in step prompts to ensure SDK agent writes expected filenames.",
          suggestedChange:
            "Add explicit filename requirements to the step constraint: 'The required artifact for this step must be named exactly XX-xxxx.md. Do not use alternative names.' Add post-SDK validation that renames misnamed artifacts.",
          expectedEffect: "Ensure all steps produce correctly named artifacts.",
          risk: "low"
        });
        break;
    }
  }

  return proposals;
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildSummary(report: RunReport, patterns: ProblemPattern[]): string {
  const lines: string[] = [];
  lines.push(
    `Pipeline ${report.status === "completed" ? "completed" : "ended with issues"}: ` +
    `${report.metrics.stepsCompleted}/14 steps, ` +
    `${report.metrics.humanGates} human gates, ` +
    `${report.metrics.falseGates} false gates, ` +
    `${(report.metrics.totalDurationMs ?? 0) / 60000}min.`
  );

  if (patterns.length === 0) {
    lines.push("No significant problems detected. Pipeline ran cleanly.");
  } else {
    lines.push(
      `${patterns.length} problem pattern(s) detected: ${patterns.map((p) => `${p.type}(${p.severity})`).join(", ")}.`
    );
  }

  return lines.join(" ");
}

function getPromptFilesForSteps(stepIds: string[]): string[] {
  // Skills ship under the bundled prompts/ dir in the standalone repo.
  return stepIds.map((id) => `prompts/migration-workflow-v2/skills/${id}-*.md`).filter(Boolean);
}
