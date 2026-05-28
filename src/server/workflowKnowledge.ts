import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { EvolutionAnalysis, ProblemPattern } from "./evolutionAnalyzer";
import type { AppConfig } from "./config";

export interface LearnedRule {
  id: string;
  sourceRunId: string;
  sourcePattern: string;
  rule: string;
  injectedInRuns: number;
  lastInjectedAt?: string;
  createdAt: string;
  active: boolean;
}

export interface WorkflowKnowledge {
  workflowSha256: string;
  totalRuns: number;
  lastRunAt: string;
  rules: LearnedRule[];
}

function knowledgeBaseDir(config: AppConfig): string {
  return path.join(config.stateRoot, "knowledge-base");
}

function knowledgePath(config: AppConfig, workflowSha: string): string {
  return path.join(knowledgeBaseDir(config), `${workflowSha}.json`);
}

export async function computeWorkflowSha256(workflowPath: string): Promise<string> {
  const content = await fs.readFile(workflowPath, "utf8");
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function loadWorkflowKnowledge(
  config: AppConfig,
  workflowSha: string
): Promise<WorkflowKnowledge | null> {
  const filePath = knowledgePath(config, workflowSha);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveWorkflowKnowledge(
  config: AppConfig,
  knowledge: WorkflowKnowledge
): Promise<void> {
  const dir = knowledgeBaseDir(config);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(knowledgePath(config, knowledge.workflowSha256), JSON.stringify(knowledge, null, 2), "utf8");
}

/**
 * Extract actionable rules from an evolution analysis and merge into knowledge base.
 * Returns the updated knowledge.
 */
export async function extractAndSaveRules(input: {
  config: AppConfig;
  workflowSha: string;
  runId: string;
  analysis: EvolutionAnalysis;
}): Promise<WorkflowKnowledge> {
  const { config, workflowSha, runId, analysis } = input;
  const existing = await loadWorkflowKnowledge(config, workflowSha);
  const now = new Date().toISOString();

  const knowledge: WorkflowKnowledge = {
    workflowSha256: workflowSha,
    totalRuns: (existing?.totalRuns ?? 0) + 1,
    lastRunAt: now,
    rules: existing?.rules ?? []
  };

  // Extract new rules from problem patterns
  const newRules = extractRulesFromPatterns(analysis.problemPatterns, runId, now);

  // Merge: deduplicate by rule text, update existing rules
  for (const rule of newRules) {
    const existingIdx = knowledge.rules.findIndex((r) => r.rule === rule.rule);
    if (existingIdx >= 0) {
      // Rule already exists — keep it active, update source if from new run
      knowledge.rules[existingIdx].active = true;
    } else {
      knowledge.rules.push(rule);
    }
  }

  await saveWorkflowKnowledge(config, knowledge);
  return knowledge;
}

function extractRulesFromPatterns(
  patterns: ProblemPattern[],
  runId: string,
  now: string
): LearnedRule[] {
  const rules: LearnedRule[] = [];

  for (const pattern of patterns) {
    switch (pattern.type) {
      case "slow_step":
        rules.push({
          id: `rule-symlink-${runId}`,
          sourceRunId: runId,
          sourcePattern: pattern.type,
          rule: "When checking model file sizes, use `stat --format='%s' FILE` or `wc -c < FILE` — never `ls -l` (symlinks show symlink string length, not target file size). Always read 01-assets.csv for model resolution context before investigating model files.",
          injectedInRuns: 0,
          createdAt: now,
          active: true
        });
        // If the step had many tool calls, add a scope constraint
        if (pattern.affectedSteps.length > 0) {
          rules.push({
            id: `rule-scope-${runId}`,
            sourceRunId: runId,
            sourcePattern: pattern.type,
            rule: `Steps ${pattern.affectedSteps.join(", ")} were slow in a prior run. Focus on completing the specific task; read prior artifact summaries first instead of re-scanning the entire filesystem.`,
            injectedInRuns: 0,
            createdAt: now,
            active: true
          });
        }
        break;

      case "repeated_failure":
        rules.push({
          id: `rule-retry-${runId}`,
          sourceRunId: runId,
          sourcePattern: pattern.type,
          rule: "If a tool call returns unexpected results (e.g., seemingly small file sizes), verify with an alternative command before drawing conclusions. Cross-reference with 01-assets.csv which records resolved paths and known issues.",
          injectedInRuns: 0,
          createdAt: now,
          active: true
        });
        break;

      case "false_gate":
        // Already handled by gate-signal.json fix, but record as a rule
        rules.push({
          id: `rule-gate-${runId}`,
          sourceRunId: runId,
          sourcePattern: pattern.type,
          rule: "Do not write gate signals in artifact text. The system controls gating via gate-signal.json only.",
          injectedInRuns: 0,
          createdAt: now,
          active: true
        });
        break;

      case "missing_artifact":
        rules.push({
          id: `rule-artifact-${runId}`,
          sourceRunId: runId,
          sourcePattern: pattern.type,
          rule: "Always write the required artifact with the exact filename specified in expectedArtifacts. Do not use alternative names or skip writing the artifact.",
          injectedInRuns: 0,
          createdAt: now,
          active: true
        });
        break;

      case "human_gate_bottleneck":
        rules.push({
          id: `rule-human-${runId}`,
          sourceRunId: runId,
          sourcePattern: pattern.type,
          rule: "If a human gate was required in a prior run for the same question, the system will auto-approve. Focus on completing the work autonomously.",
          injectedInRuns: 0,
          createdAt: now,
          active: true
        });
        break;
    }
  }

  return rules;
}

/**
 * Format learned rules for injection into SDK agent prompts.
 */
export function formatRulesForPrompt(rules: LearnedRule[]): string {
  const activeRules = rules.filter((r) => r.active);
  if (activeRules.length === 0) return "";

  return [
    "## Learned rules from prior runs",
    "These rules were extracted from previous execution analysis. Follow them to avoid known pitfalls:",
    "",
    ...activeRules.map((r, i) => `${i + 1}. ${r.rule}  *(from run ${r.sourceRunId.slice(0, 8)}...)*`),
    ""
  ].join("\n");
}
