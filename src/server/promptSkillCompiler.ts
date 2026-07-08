import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationStepDefinition, MigrationTask, StepJob } from "../shared/types";
import type { AppConfig } from "./config";
import { injectRecipesForWorkflow, getMatchedRecipeIds } from "./recipeInjector";
import { injectSkillsForWorkflow, getMatchedSkillIds } from "./skillInjector";
import { extractNodeModelPairs } from "./recipeInjector";
import { recordRecipeApplied, recordSkillInjected } from "./analyticsDb";
import { computeWorkflowSha256, formatRulesForPrompt, loadWorkflowKnowledge } from "./workflowKnowledge";
import { loadGpuNodes, pickNode, renderGpuNodeBlock } from "./gpuNodes";

export async function compileStepJob(input: {
  config: AppConfig;
  task: MigrationTask;
  step: MigrationStepDefinition;
  resumeContext?: Record<string, unknown>;
}): Promise<StepJob> {
  const promptText = await readOptional(input.step.promptPath);
  const skillText = await readOptional(input.step.skillPath);
  const commonContractText = await readCommonMigrationContract(input.config.draftDocRoot);
  const priorArtifacts = await listArtifactFiles(input.task.artifactPath);
  const recommendedInputArtifacts = recommendedInputArtifactsForStep(input.step.id);
  const availableInputArtifacts = recommendedInputArtifacts.filter((artifact) =>
    priorArtifacts.includes(artifact)
  );
  const unavailableRecommendedInputArtifacts = recommendedInputArtifacts.filter(
    (artifact) => !priorArtifacts.includes(artifact)
  );
  const instructions = buildInstructions({
    task: input.task,
    step: input.step,
    commonContractText,
    promptText,
    skillText
  });

  // Load learned rules from knowledge base
  let learnedRulesSection = "";
  try {
    const workflowSha = await computeWorkflowSha256(input.task.workflowPath);
    const knowledge = await loadWorkflowKnowledge(input.config, workflowSha);
    if (knowledge && knowledge.rules.length > 0) {
      learnedRulesSection = formatRulesForPrompt(knowledge.rules);
      // Update injection counters
      for (const rule of knowledge.rules) {
        rule.injectedInRuns += 1;
        rule.lastInjectedAt = new Date().toISOString();
      }
      // Save updated counters (best-effort)
      const { saveWorkflowKnowledge } = await import("./workflowKnowledge");
      await saveWorkflowKnowledge(input.config, knowledge);
    }
  } catch {
    // Knowledge injection is best-effort
  }

  // Recipe library injection (§L, hard-injection layer).
  // Best-effort: returns "" for steps that don't need recipes or when no
  // match exists. See recipeInjector.ts and feedback memory two_layer_injection.
  const matchedRecipesSection = await injectRecipesForWorkflow({
    workflowPath: input.task.workflowPath,
    stepId: input.step.id
  }).catch(() => "");

  // Skill library injection (§M, soft-injection layer).
  // Best-effort: returns "" when no triggers match. Any step can receive
  // skill injections — trigger evaluation handles per-step gating.
  const matchedSkillsSection = await injectSkillsForWorkflow({
    workflowPath: input.task.workflowPath,
    stepId: input.step.id
  }).catch(() => "");

  // §H analytics: record what was injected (fire-and-forget, never throws).
  try {
    const recipeIds = getMatchedRecipeIds(input.task.workflowPath, input.step.id);
    if (recipeIds.length > 0) recordRecipeApplied(input.task.id, input.step.id, recipeIds);

    const pairs = extractNodeModelPairs(
      JSON.parse(await fs.readFile(input.task.workflowPath, "utf8"))
    );
    const skillIds = getMatchedSkillIds({ stepId: input.step.id, nodeModelPairs: pairs });
    for (const sid of skillIds) recordSkillInjected(input.task.id, input.step.id, sid, "unknown");
  } catch { /* analytics is best-effort */ }

  // GPU node lookup: override comfyuiRoot + modelRoots from the task's pinned
  // node (so the agent sees the remote paths it actually needs), and produce a
  // gpuNodeBlock the Step 05 skill branches on. Falls back silently to the
  // synthesized default local node when no config exists.
  let gpuNodeBlock: string | undefined;
  let comfyuiRoot = input.config.comfyuiRoot;
  let modelRoots = input.config.modelRoots;
  try {
    const registry = loadGpuNodes(input.config);
    const node = pickNode(registry, input.task.gpuNode);
    comfyuiRoot = node.comfyui_root;
    modelRoots = node.model_roots;
    gpuNodeBlock = renderGpuNodeBlock(node, input.task.id);
  } catch (err) {
    // Config error → log and fall through with defaults. The Step 05 skill
    // will use the existing local-launch flow.
    console.warn(`[compileStepJob] gpu-nodes.json load failed: ${(err as Error).message}`);
  }

  return {
    taskId: input.task.id,
    stepId: input.step.id,
    stepName: input.step.name,
    promptPath: input.step.promptPath,
    skillPath: input.step.skillPath,
    workspacePath: input.task.workspacePath,
    artifactPath: input.task.artifactPath,
    workflowPath: input.task.workflowPath,
    modelRoots,
    comfyuiRoot,
    instructions,
    constraints: [
      "Do not modify the source workflow in place.",
      "Do not bypass, delete, collapse, or replace workflow nodes to force success.",
      "Write all outputs to the task artifact folder.",
      "Do not write credentials, tokens, passwords, or private connection strings into artifacts.",
      "Do not paste full large artifacts, workflow JSON, model listings, SDK transcripts, or long command output into the assistant response; store them as artifacts and summarize paths, counts, statuses, and blockers.",
      "Do NOT write gate signals (orchestrator_status, human_gate_reached, human gate, etc.) in your artifact files. Gating is controlled exclusively by the system via gate-signal.json files. Your job is to complete the work and produce complete artifacts.",
      "If you encounter a genuine blocker (missing assets, ambiguous decisions), document it factually in the artifact without using gate keywords. The system will decide whether human intervention is needed."
    ],
    requiredContext: {
      workflowPath: input.task.workflowPath,
      artifactPath: input.task.artifactPath,
      workspacePath: input.task.workspacePath,
      modelRoots,
      comfyuiRoot,
      priorArtifacts,
      recommendedInputArtifacts,
      availableInputArtifacts,
      unavailableRecommendedInputArtifacts
    },
    expectedArtifacts: [input.step.requiredOutput],
    humanGates: [input.step.humanIntervention],
    hardStopRules: [
      "A critical model or input source is unknown.",
      "A critical custom node source is unknown.",
      "A workflow semantic change is required without human approval.",
      "Execution would require bypassing, deleting, or replacing nodes.",
      "Capacity evidence and runtime failure agree on a hard stop.",
      "Any required asset (model, LoRA, VAE, input, custom node) could not be found, downloaded, or aliased after search."
    ],
    resumeContext: input.resumeContext,
    learnedRules: learnedRulesSection || undefined,
    matchedRecipes: matchedRecipesSection || undefined,
    matchedSkills: matchedSkillsSection || undefined,
    ...(gpuNodeBlock ? { gpuNodeBlock } : {})
  };
}

export function serializeStepJobForAgent(job: StepJob): string {
  return [
    `# ComfyUI Intel XPU migration Step ${job.stepId}: ${job.stepName}`,
    "",
    "You are executing one migration step for a web-orchestrated migration system.",
    "Run autonomously until this step is complete or a genuine hard stop is proven. Do not self-trigger human gates — the system controls gating via gate-signal.json.",
    "",
    "## Structured StepJob",
    "```json",
    JSON.stringify(
      {
        taskId: job.taskId,
        stepId: job.stepId,
        stepName: job.stepName,
        workflowPath: job.workflowPath,
        workspacePath: job.workspacePath,
        artifactPath: job.artifactPath,
        modelRoots: job.modelRoots,
        comfyuiRoot: job.comfyuiRoot,
        promptPath: job.promptPath,
        skillPath: job.skillPath,
        requiredContext: job.requiredContext,
        expectedArtifacts: job.expectedArtifacts,
        humanGates: job.humanGates,
        hardStopRules: job.hardStopRules,
        resumeContext: job.resumeContext
      },
      null,
      2
    ),
    "```",
    "",
    "## Non-negotiable constraints",
    ...job.constraints.map((constraint) => `- ${constraint}`),
    "",
    "## Step instructions",
    "Before deep exploration, read the artifacts listed in `requiredContext.availableInputArtifacts`, then use `requiredContext.priorArtifacts` for any additional evidence discovery. Treat `requiredContext.recommendedInputArtifacts` as the step's prompt-input contract; if an expected predecessor artifact is unavailable, record whether it is optional, not applicable, or a blocker. Then create or update the required artifact named in `expectedArtifacts` with the evidence already available. Keep updating that artifact incrementally. Once the required artifact is complete enough to support a safe next-step decision, stop and return the final response instead of continuing open-ended investigation.",
    "For large local scans, use targeted summaries instead of broad dumps. The next step must read durable artifacts, not this chat transcript.",
    "",
    stepScopedExecutionHint(job),
    "",
    ...(job.learnedRules ? [job.learnedRules, ""] : []),
    ...(job.matchedRecipes ? [job.matchedRecipes, ""] : []),
    ...(job.matchedSkills ? [job.matchedSkills, ""] : []),
    ...(job.gpuNodeBlock ? [job.gpuNodeBlock, ""] : []),
    job.instructions,
    "",
    "## Required final response",
    "Return a concise step summary with status, artifacts written, human inputs needed, hard stops, and next step."
  ].join("\n");
}

function stepScopedExecutionHint(job: StepJob): string {
  if (job.stepId !== "04") {
    return "Use the prior step artifacts and the source workflow as the primary scope. Do not expand into unrelated repository-wide audits unless the step explicitly requires it.";
  }

  return [
    "Step 04 source-audit scope:",
    "- Write `04-source-audit.md` first, then refine it.",
    "- Use `01-assets.csv`, `01-custom-nodes.md`, and `03-inventory.md` as the source of truth for assets, custom-node packages, and active branches.",
    "- Focus on active critical node families only: QwenVL (`AILab_QwenVL`), SeedVR2 loaders/upscaler, `AIO_Preprocessor`/DepthAnything, ZImage/FLUX/ControlNet-related nodes, `LayerUtility: PurgeVRAM V2`, and critical KJNodes/rgthree outputs.",
    "- Treat disconnected utility/example nodes as non-blocking unless source evidence shows they affect an active output branch.",
    "- Capture CUDA/MPS/CPU-only device selection, attention/provider assumptions, hidden downloads, runtime asset paths, and places requiring copied-workflow policy changes.",
    "- Stop after producing the scoped audit; do not perform environment deployment or runtime validation in Step 04."
  ].join("\n");
}

async function readOptional(filePath?: string): Promise<string> {
  if (!filePath) {
    return "";
  }
  return fs.readFile(filePath, "utf8");
}

async function listArtifactFiles(artifactPath: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(dir: string, prefix = ""): Promise<void> {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const relativePath = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await visit(path.join(dir, entry.name), relativePath);
      } else if (entry.isFile()) {
        results.push(relativePath);
      }
    }
  }
  await visit(artifactPath);
  return results.sort();
}

function recommendedInputArtifactsForStep(stepId: string): string[] {
  switch (stepId) {
    case "00":
      return [];
    case "01":
      return ["00-intake-preflight.md"];
    case "02":
      return ["00-intake-preflight.md", "01-assets.csv", "01-custom-nodes.md"];
    case "03":
      return [
        "00-intake-preflight.md",
        "01-assets.csv",
        "01-custom-nodes.md",
        "02-feasibility.md"
      ];
    case "04":
      return ["01-assets.csv", "01-custom-nodes.md", "03-inventory.md", "03-workflow-topology.md"];
    case "05":
      return ["01-assets.csv", "01-custom-nodes.md", "04-source-audit.md"];
    case "06":
      return ["03-inventory.md", "03-workflow-topology.md", "05-environment.md"];
    case "07":
      return [
        "03-inventory.md",
        "03-workflow-topology.md",
        "06-prompt.json",
        "06-prompt-validation.json",
        "06b-runtime-policy-prompt.json"
      ];
    case "08":
      return ["06-prompt.json", "06b-runtime-policy-prompt.json", "07-first-stage-smoke.md"];
    case "09":
      return ["08-full-validation.md"];
    case "10":
      return ["03-inventory.md", "06-prompt-validation.json", "07-first-stage-smoke.md", "08-full-validation.md"];
    case "11":
      return ["08-full-validation.md", "09-tuning.md", "10-coverage-review.md"];
    case "12":
      return ["11-delivery.md", "migration-result-report.md"];
    case "13":
      return [
        "task-state.json",
        "phase1-context/running-summary.md",
        "phase1-context/context-debt.json",
        "phase1-context/phase3-extraction-candidates.json",
        "12-gui-acceptance.md",
        "12-output-manifest.json"
      ];
    default:
      return [];
  }
}

function buildInstructions(input: {
  task: MigrationTask;
  step: MigrationStepDefinition;
  commonContractText: string;
  promptText: string;
  skillText: string;
}): string {
  const promptLabel = input.step.promptPath
    ? path.relative(input.task.workspacePath, input.step.promptPath)
    : "none";
  const skillLabel = input.step.skillPath
    ? path.relative(input.task.workspacePath, input.step.skillPath)
    : "none";

  return [
    `Prompt source: ${promptLabel}`,
    `Skill source: ${skillLabel}`,
    "",
    ...(input.commonContractText ? [input.commonContractText, ""] : []),
    "### Prompt",
    input.promptText || "(No dedicated prompt file for this step.)",
    "",
    "### Skill",
    input.skillText || "(No dedicated skill file for this step; use the workflow README/QuickStart contract.)"
  ].join("\n");
}

async function readCommonMigrationContract(draftDocRoot: string): Promise<string> {
  const agentPath = path.join(draftDocRoot, "migration-workflow-v2", "agent.md");
  let agentText = "";
  try {
    agentText = await fs.readFile(agentPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  return extractMarkdownSection(agentText, "Common Migration Contract");
}

function extractMarkdownSection(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trim();
}
