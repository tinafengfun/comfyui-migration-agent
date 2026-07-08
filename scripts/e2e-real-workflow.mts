/**
 * E2E test with a REAL workflow from the cartoon directory.
 *
 * Run: npx tsx scripts/e2e-real-workflow.mts <path-to-workflow.json>
 *
 * Loads an actual user workflow, creates a task, compiles prompts for all
 * recipe-injection steps (02/04/05), and shows which recipes + skills get
 * injected. This validates the system on real-world data.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

// ── Resolve paths ────────────────────────────────────────────────────────────
const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(agentRoot);

const workflowPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : "/home/intel/tianfeng/comfy/cartoon/Z+Image+Extreme+Asthetics+ControlNet+(极致人体CN版）.json";

console.log(`━${"━".repeat(70)}━`);
console.log(`  Real workflow E2E test`);
console.log(`  File: ${path.basename(workflowPath)}`);
console.log(`━${"━".repeat(70)}━`);

// ── Set up temp workspace ────────────────────────────────────────────────────
const tmpRoot = path.join(agentRoot, ".demo-state", "tests", `real-${Date.now()}`);
const workspaceRoot = path.join(tmpRoot, "workspaces");
const stateRoot = path.join(tmpRoot, "state");
const dbPath = path.join(tmpRoot, "analytics.sqlite");

process.env.DEMO_WORKSPACE_ROOT = workspaceRoot;
process.env.DEMO_STATE_ROOT = stateRoot;
process.env.MIGRATION_ANALYTICS_DB = dbPath;

// ── Imports ──────────────────────────────────────────────────────────────────
const src = (p: string) => path.resolve(agentRoot, "src/server", p);
const { MigrationOrchestrator } = await import(src("orchestrator"));
const { StateStore } = await import(src("state"));
const { ensureDir } = await import(src("fsUtils"));
const { compileStepJob, serializeStepJobForAgent } = await import(src("promptSkillCompiler"));
const { extractNodeModelPairs } = await import(src("recipeInjector"));
const { closeDb, computeRecipeEfficacy, syncFeedbackFromJsonl } = await import(src("analyticsDb"));

// ── Load the real workflow ───────────────────────────────────────────────────
const workflowRaw = await fs.readFile(workflowPath, "utf8");
const workflowJson = JSON.parse(workflowRaw);

const wfNodes = (workflowJson as any).nodes ?? [];
const wfLinks = (workflowJson as any).links ?? [];
console.log(`\n  Loaded: ${wfNodes.length} nodes, ${wfLinks.length} links`);

// Show node types summary
const typeCounts: Record<string, number> = {};
for (const n of wfNodes) {
  const t = n.type ?? "?";
  typeCounts[t] = (typeCounts[t] ?? 0) + 1;
}
const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
console.log(`  Top node types:`);
for (const [t, c] of sortedTypes.slice(0, 10)) {
  console.log(`    ${t}: ${c}`);
}

// Show model files
const allPairs = extractNodeModelPairs(workflowJson);
const modelPairs = allPairs.filter((p) => p.modelFilename);
console.log(`\n  Model files found (${modelPairs.length}):`);
for (const p of modelPairs) {
  console.log(`    ${p.nodeType} → ${path.basename(p.modelFilename!)}`);
}

// ── Create config + store + orchestrator ─────────────────────────────────────
await ensureDir(workspaceRoot);
const config = {
  port: 0,
  projectRoot: tmpRoot,
  workspaceRoot,
  stateRoot,
  draftDocRoot: path.join(agentRoot, "prompts"),
  comfyuiRoot: "/tmp/comfy",
  modelRoots: ["/home/intel/hf_models"],
  autoApproveAgentPermissions: false
};

const store = new StateStore(config);
await store.initialize();

const allSteps = [
  { id: "00", name: "Intake & Preflight", requiredOutput: "00-intake-preflight.md", humanIntervention: "x",
    prompt: "migration-workflow-v2/prompts/00-intake-preflight-prompt.md",
    skill: "migration-workflow-v2/skills/00-intake-preflight-skill.md" },
  { id: "01", name: "Asset & Custom-Node Resolution", requiredOutput: "01-assets.csv", humanIntervention: "x",
    prompt: "migration-workflow-v2/prompts/01-asset-and-custom-node-resolution-prompt.md",
    skill: "migration-workflow-v2/skills/01-asset-and-custom-node-resolution-skill.md" },
  { id: "02", name: "Feasibility Analysis", requiredOutput: "02-feasibility.md", humanIntervention: "x",
    prompt: "migration-workflow-v2/prompts/02-feasibility-analysis-prompt.md",
    skill: "migration-workflow-v2/skills/02-feasibility-analysis-skill.md" },
  { id: "04", name: "Source Audit", requiredOutput: "04-source-audit.md", humanIntervention: "x",
    prompt: "migration-workflow-v2/prompts/04-source-audit-prompt.md",
    skill: "migration-workflow-v2/skills/04-source-audit-skill.md" },
  { id: "05", name: "Environment Deployment", requiredOutput: "05-environment-deployment.md", humanIntervention: "x",
    prompt: "migration-workflow-v2/prompts/05-environment-deployment-prompt.md",
    skill: "migration-workflow-v2/skills/05-environment-deployment-skill.md" },
];

const orchestrator = new MigrationOrchestrator(config, store, allSteps);

// ── Create task from real workflow ───────────────────────────────────────────
console.log(`\n━${"━".repeat(70)}━`);
console.log(`  Creating task from real workflow...`);
console.log(`━${"━".repeat(70)}━`);

const task = await orchestrator.createTask({
  name: path.basename(workflowPath).replace(/\.json$/, ""),
  workflowFileName: path.basename(workflowPath),
  workflowJson
});

console.log(`  ✓ Task: ${task.id}`);
console.log(`  ✓ Workspace: ${task.workspacePath}`);

// ── Compile each step and show injections ────────────────────────────────────
console.log(`\n━${"━".repeat(70)}━`);
console.log(`  Compiling step prompts — checking recipe + skill injection`);
console.log(`━${"━".repeat(70)}━`);

const injectionSteps = ["02", "04", "05"];
const stepLabels: Record<string, string> = {
  "02": "Feasibility Analysis",
  "04": "Source Audit",
  "05": "Environment Deployment"
};

for (const stepId of injectionSteps) {
  const step = allSteps.find((s) => s.id === stepId)!;
  const fullStep = {
    ...step,
    promptPath: path.join(config.draftDocRoot, step.prompt!),
    skillPath: path.join(config.draftDocRoot, step.skill!)
  } as any;

  console.log(`\n  ── Step ${stepId}: ${stepLabels[stepId]} ──`);

  const stepJob = await compileStepJob({ config, task, step: fullStep });
  const prompt = serializeStepJobForAgent(stepJob);

  // Extract recipe section
  const recipeStart = prompt.indexOf("## Matched recipes");
  if (recipeStart >= 0) {
    const recipeEnd = prompt.indexOf("\n## ", recipeStart + 10);
    const recipeSection = prompt.slice(recipeStart, recipeEnd > 0 ? recipeEnd : recipeStart + 500);
    const recipeIds = recipeSection.match(/###\s+(\S+)/g)?.map((s) => s.replace("### ", "")) ?? [];
    console.log(`    Recipes injected: ${recipeIds.length > 0 ? recipeIds.join(", ") : "(none)"}`);
    if (recipeIds.length > 0) {
      // Show first workaround hint
      const workaroundMatch = recipeSection.match(/\d+\.\s+\*\*(.+?)\*\*/);
      if (workaroundMatch) console.log(`    First workaround: ${workaroundMatch[1]}`);
    }
  } else {
    console.log(`    Recipes injected: (none)`);
  }

  // Extract skills section
  const skillStart = prompt.indexOf("## Matched on-demand skills");
  if (skillStart >= 0) {
    const skillEnd = prompt.indexOf("\n## ", skillStart + 10);
    const skillSection = prompt.slice(skillStart, skillEnd > 0 ? skillEnd : skillStart + 500);
    const skillIds = skillSection.match(/### Skill:\s+(\S+)/g)?.map((s) => s.replace("### Skill: ", "")) ?? [];
    console.log(`    Skills injected:  ${skillIds.length > 0 ? skillIds.join(", ") : "(none)"}`);
    if (skillIds.length > 0) {
      // Show skill description snippet
      const descMatch = skillSection.match(/v[\d.]+\)\s*\n\s*(.+)/);
      if (descMatch) console.log(`    Skill desc:       ${descMatch[1].slice(0, 80)}`);
    }
  } else {
    console.log(`    Skills injected:  (none)`);
  }

  // Show prompt size
  console.log(`    Prompt size:      ${prompt.length} chars`);
}

// ── Show analytics ───────────────────────────────────────────────────────────
console.log(`\n━${"━".repeat(70)}━`);
console.log(`  Analytics summary`);
console.log(`━${"━".repeat(70)}━`);

const efficacy = computeRecipeEfficacy();
if (efficacy.length > 0) {
  for (const r of efficacy) {
    console.log(`    Recipe ${r.recipeId}: applied=${r.appliedCount}, success=${r.successCount}, failed=${r.failedCount}`);
  }
} else {
  console.log(`    (no recipe usage recorded — no recipe matched this workflow)`);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
closeDb();
await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n━${"━".repeat(70)}━`);
console.log(`  Done`);
console.log(`━${"━".repeat(70)}━`);
