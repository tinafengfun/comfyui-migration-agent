import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationStepDefinition } from "../shared/types";
import type { AppConfig } from "./config";

const stepSeed: Array<Omit<MigrationStepDefinition, "promptPath" | "skillPath"> & {
  prompt?: string;
  skill?: string;
}> = [
  {
    id: "00",
    name: "Intake and dependency-source preflight",
    prompt: "migration-workflow-v2/prompts/00-intake-preflight-prompt.md",
    skill: "migration-workflow-v2/skills/00-intake-preflight-skill.md",
    requiredOutput: "00-intake-preflight.md",
    humanIntervention: "Provide missing model/custom-node sources or credentials through approved channels."
  },
  {
    id: "01",
    name: "Asset and custom-node resolution",
    prompt: "migration-workflow-v2/prompts/01-asset-and-custom-node-resolution-prompt.md",
    skill: "migration-workflow-v2/skills/01-asset-and-custom-node-resolution-skill.md",
    requiredOutput: "01-assets.csv / 01-custom-nodes.md",
    humanIntervention: "Provide missing model/custom-node sources or approve smoke-only aliases."
  },
  {
    id: "02",
    name: "Feasibility analysis",
    prompt: "migration-workflow-v2/prompts/02-feasibility-analysis-prompt.md",
    skill: "migration-workflow-v2/skills/02-feasibility-analysis-skill.md",
    requiredOutput: "02-feasibility.md",
    humanIntervention: "Confirm target fidelity, hardware budget, and reduced-resource policy."
  },
  {
    id: "03",
    name: "Workflow inventory",
    prompt: "migration-workflow-v2/prompts/03-workflow-inventory-prompt.md",
    skill: "migration-workflow-v2/skills/03-workflow-inventory-skill.md",
    requiredOutput: "03-inventory.md",
    humanIntervention: "Clarify ambiguous branches and in-scope outputs."
  },
  {
    id: "04",
    name: "Source audit",
    prompt: "migration-workflow-v2/prompts/04-source-audit-prompt.md",
    skill: "migration-workflow-v2/skills/04-source-audit-skill.md",
    requiredOutput: "04-source-audit.md",
    humanIntervention: "Classify CUDA-only paths as patch, fallback, feature work, or out of scope."
  },
  {
    id: "05",
    name: "Environment deployment",
    prompt: "migration-workflow-v2/prompts/05-environment-deployment-prompt.md",
    skill: "migration-workflow-v2/skills/05-environment-deployment-skill.md",
    requiredOutput: "05-environment.md",
    humanIntervention: "Approve environment assumptions, package install blockers, or patches."
  },
  {
    id: "06",
    name: "Prompt conversion validation",
    prompt: "migration-workflow-v2/prompts/06-prompt-conversion-validation-prompt.md",
    skill: "migration-workflow-v2/skills/06-prompt-conversion-validation-skill.md",
    requiredOutput: "06-prompt.json / 06-prompt-validation.json",
    humanIntervention: "Decide schema or runtime-policy changes that alter workflow semantics."
  },
  {
    id: "07",
    name: "Branch smoke validation",
    prompt: "migration-workflow-v2/prompts/07-branch-smoke-validation-prompt.md",
    skill: "migration-workflow-v2/skills/07-branch-smoke-validation-skill.md",
    requiredOutput: "07-{branch_slug}-smoke.md",
    humanIntervention: "Review reduced settings and smoke-tier output quality."
  },
  {
    id: "08",
    name: "Full validation and capacity",
    prompt: "migration-workflow-v2/prompts/08-full-validation-and-capacity-prompt.md",
    skill: "migration-workflow-v2/skills/08-full-validation-and-capacity-skill.md",
    requiredOutput: "08-full-validation.md",
    humanIntervention: "Choose capacity mitigation, hardware escalation, or hard stop."
  },
  {
    id: "09",
    name: "Performance tuning",
    prompt: "migration-workflow-v2/prompts/09-performance-tuning-prompt.md",
    skill: "migration-workflow-v2/skills/09-performance-tuning-skill.md",
    requiredOutput: "09-tuning.md",
    humanIntervention: "Choose optimization target and stopping point."
  },
  {
    id: "10",
    name: "Coverage review",
    prompt: "migration-workflow-v2/prompts/10-coverage-review-prompt.md",
    skill: "migration-workflow-v2/skills/10-coverage-review-skill.md",
    requiredOutput: "10-coverage-review.md",
    humanIntervention: "Approve support statement and any gaps."
  },
  {
    id: "11",
    name: "Delivery packaging",
    prompt: "migration-workflow-v2/prompts/11-delivery-packaging-prompt.md",
    skill: "migration-workflow-v2/skills/11-delivery-packaging-skill.md",
    requiredOutput: "11-delivery.md / migration result report",
    humanIntervention: "Approve customer-facing wording and final release readiness."
  },
  {
    id: "12",
    name: "GUI acceptance and demo",
    prompt: "migration-workflow-v2/prompts/12-gui-acceptance-demo-prompt.md",
    skill: "migration-workflow-v2/skills/12-gui-acceptance-demo-skill.md",
    requiredOutput: "12-gui-acceptance.md",
    humanIntervention: "Run clean GUI workflow and sign off generated outputs."
  },
  {
    id: "13",
    name: "Agent improvement and playbook hardening",
    prompt: "migration-workflow-v2/prompts/13-agent-improvement-prompt.md",
    skill: "migration-workflow-v2/skills/13-agent-improvement-skill.md",
    requiredOutput: "13-agent-improvement.* / 13-playbook-patch-plan.md / 13-phase3-readiness.json / 13-reflection.*",
    humanIntervention: "Approve medium-risk prompt/skill changes and high-risk backend/tool behavior changes from the Step 13 patch plan."
  }
];

export async function loadStepDefinitions(config: AppConfig): Promise<MigrationStepDefinition[]> {
  return Promise.all(
    stepSeed.map(async (step) => {
      const promptPath = step.prompt ? path.join(config.draftDocRoot, step.prompt) : undefined;
      const skillPath = step.skill ? path.join(config.draftDocRoot, step.skill) : undefined;
      await assertOptionalFile(promptPath);
      await assertOptionalFile(skillPath);
      return {
        id: step.id,
        name: step.name,
        promptPath,
        skillPath,
        requiredOutput: step.requiredOutput,
        humanIntervention: step.humanIntervention
      };
    })
  );
}

async function assertOptionalFile(filePath?: string): Promise<void> {
  if (!filePath) {
    return;
  }
  await fs.access(filePath);
}
