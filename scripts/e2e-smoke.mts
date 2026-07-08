/**
 * E2E smoke test: simulate a full user use case from the perspective of
 * "user uploads FP8 workflow → agent compiles prompt → hard-stop → feedback → analytics".
 *
 * Run: npx tsx scripts/e2e-smoke.mts
 *
 * This does NOT start the server or run the LLM. It exercises the same module
 * calls the server makes, in the same order, so we can verify the wiring.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

// ── Set up a temp workspace that looks like a real task ─────────────────────
const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(agentRoot);

const tmpRoot = path.join(agentRoot, ".demo-state", "tests", `e2e-${Date.now()}`);
const workspaceRoot = path.join(tmpRoot, "workspaces");
const stateRoot = path.join(tmpRoot, "state");
const dbPath = path.join(tmpRoot, "analytics.sqlite");

process.env.DEMO_WORKSPACE_ROOT = workspaceRoot;
process.env.DEMO_STATE_ROOT = stateRoot;
process.env.MIGRATION_ANALYTICS_DB = dbPath;

// ── Imports (after env vars are set so paths resolve correctly) ─────────────
// Use absolute paths resolved from agentRoot — the script lives in scripts/ so
// relative imports would otherwise resolve to scripts/src/...
const src = (p: string) => path.resolve(agentRoot, "src/server", p);
const { MigrationOrchestrator } = await import(src("orchestrator"));
const { StateStore } = await import(src("state"));
const { ensureDir } = await import(src("fsUtils"));
const { compileStepJob, serializeStepJobForAgent } = await import(src("promptSkillCompiler"));
const { listFeedbackEvents } = await import(src("feedbackLog"));
const { computeRecipeEfficacy, recordRecipeApplied, recordRecipeOutcome, closeDb, syncFeedbackFromJsonl } = await import(src("analyticsDb"));

// ── Step 1: create config + store + orchestrator ────────────────────────────
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

// Full 14-step pipeline (simplified — we only exercise a few steps)
const steps = [
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

const orchestrator = new MigrationOrchestrator(config, store, steps);

// ── Step 2: create a task with an FP8 workflow (user upload) ─────────────────
console.log("━━━ Step 1: User uploads FP8 workflow ━━━");

const WORKFLOW = {
  nodes: [
    { id: 1, type: "CLIPLoader", widgets_values: ["qwen_2.5_vl_7b_fp8_scaled.safetensors"] },
    { id: 2, type: "UNETLoader", widgets_values: ["flux1-dev.safetensors"] },
    { id: 3, type: "VAELoader", widgets_values: ["ae.safetensors"] },
    { id: 4, type: "AIO_Preprocessor" },
    { id: 5, type: "SeedVR2Upscaler", widgets_values: ["seedvr2-base.pth"] }
  ],
  links: []
};

const task = await orchestrator.createTask({
  name: "fp8-e2e-demo",
  workflowFileName: "qwen-fp8-workflow.json",
  workflowJson: WORKFLOW
});

console.log(`  ✓ Task created: ${task.id}`);
console.log(`  ✓ Workspace: ${task.workspacePath}`);
console.log(`  ✓ Workflow: ${task.workflowPath}`);

// ── Step 3: compile Step 02 prompt — verify recipe + skill injection ─────────
console.log("\n━━━ Step 2: Compile Step 02 (Feasibility) — check recipe + skill injection ━━━");

const step02 = steps.find((s) => s.id === "02")!;
const fullStep02 = {
  ...step02,
  promptPath: path.join(config.draftDocRoot, step02.prompt!),
  skillPath: path.join(config.draftDocRoot, step02.skill!)
} as any;

const stepJob = await compileStepJob({
  config,
  task,
  step: fullStep02
});

const prompt = serializeStepJobForAgent(stepJob);

// Check recipe injection
const hasRecipe = prompt.includes("CLIPLoader-qwen-fp8");
console.log(`  ${hasRecipe ? "✓" : "✗"} Recipe 'CLIPLoader-qwen-fp8' injected: ${hasRecipe}`);

if (hasRecipe) {
  // Show a snippet of the recipe section
  const recipeStart = prompt.indexOf("## Matched recipes");
  const recipeSnippet = prompt.slice(recipeStart, recipeStart + 200);
  console.log(`  ┌─ Recipe snippet:`);
  console.log(`  │ ${recipeSnippet.split("\n").slice(0, 4).join("\n  │ ")}`);
}

// Check skill injection
const hasSkill = prompt.includes("fp8-feasibility-checklist");
console.log(`  ${hasSkill ? "✓" : "✗"} Skill 'fp8-feasibility-checklist' injected: ${hasSkill}`);

if (hasSkill) {
  const skillStart = prompt.indexOf("## Matched on-demand skills");
  const skillSnippet = prompt.slice(skillStart, skillStart + 200);
  console.log(`  ┌─ Skill snippet:`);
  console.log(`  │ ${skillSnippet.split("\n").slice(0, 4).join("\n  │ ")}`);
}

// Check analytics tracking fired
const efficacyAfterApply = computeRecipeEfficacy();
const clipEfficacy = efficacyAfterApply.find((e) => e.recipeId === "CLIPLoader-qwen-fp8");
console.log(`  ${clipEfficacy ? "✓" : "✗"} Analytics: recipe_usage recorded (applied=${clipEfficacy?.appliedCount ?? 0})`);

// ── Step 4: compile Step 04 — verify xpu-attention + seedvr2 skills ──────────
console.log("\n━━━ Step 3: Compile Step 04 (Source Audit) — check attention + seedvr2 skills ━━━");

const step04 = steps.find((s) => s.id === "04")!;
const fullStep04 = {
  ...step04,
  promptPath: path.join(config.draftDocRoot, step04.prompt!),
  skillPath: path.join(config.draftDocRoot, step04.skill!)
} as any;

const stepJob04 = await compileStepJob({
  config,
  task,
  step: fullStep04
});
const prompt04 = serializeStepJobForAgent(stepJob04);

const hasAttnSkill = prompt04.includes("xpu-attention-fallback");
const hasSeedvr2Skill = prompt04.includes("seedvr2-loader-workaround");
console.log(`  ${hasAttnSkill ? "✓" : "✗"} Skill 'xpu-attention-fallback' injected: ${hasAttnSkill}`);
console.log(`  ${hasSeedvr2Skill ? "✓" : "✗"} Skill 'seedvr2-loader-workaround' injected: ${hasSeedvr2Skill}`);

// ── Step 5: simulate a hard-stop (user hits "stop" on Step 02) ───────────────
console.log("\n━━━ Step 4: User hard-stops Step 02 (FP8 VRAM insufficient) ━━━");

const report = await orchestrator.terminateWithHardStop({
  taskId: task.id,
  stepId: "02",
  reason: "Target XPU has only 8GB VRAM; FP8→bf16 dequant needs ~14GB. No viable path without CPU offload.",
  improvementStrategy: "Add VRAM gate to Step 02 feasibility — auto-route to CPU offload when VRAM < model_size * 2"
});

console.log(`  ✓ Hard-stop report: ${report.artifactPath}`);

// ── Step 6: verify feedback event was auto-collected ━━━━━━━━━━━━━━━━━━━━━━━
console.log("\n━━━ Step 5: Verify feedback event auto-collected (§G.wire) ━━━");

const { events, corrupt } = await listFeedbackEvents(workspaceRoot, task.id);
console.log(`  Feedback events: ${events.length}, corrupt: ${corrupt.length}`);

if (events.length > 0) {
  const evt = events[0];
  console.log(`  ┌─ Event details:`);
  console.log(`  │ type:        ${evt.type}`);
  console.log(`  │ severity:    ${evt.severity}`);
  console.log(`  │ source:      ${evt.source}`);
  console.log(`  │ status:      ${evt.status}`);
  console.log(`  │ stepId:      ${evt.stepId}`);
  console.log(`  │ message:     ${evt.message.slice(0, 80)}...`);
  if (evt.proposedAction) console.log(`  │ proposed:    ${evt.proposedAction}`);
  if (evt.stateSnapshot?.failingArtifactPath) console.log(`  │ artifact:    ${evt.stateSnapshot.failingArtifactPath}`);
  console.log(`  └─`);
}

// ── Step 7: sync feedback → SQLite ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log("\n━━━ Step 6: Sync feedback JSONL → SQLite (§H) ━━━");

const syncStats = await syncFeedbackFromJsonl(workspaceRoot);
console.log(`  ✓ Synced ${syncStats.synced} feedback events to SQLite`);

// ── Step 8: check recipe efficacy (applied but failed) ━━━━━━━━━━━━━━━━━━━━━
console.log("\n━━━ Step 7: Query recipe efficacy (§H) ━━━");

// Step 02 was hard-stopped, so it's neither completed nor failed via the normal
// step-run path. Let's also simulate a step completion to show the success path.
recordRecipeApplied(task.id, "04", ["CLIPLoader-qwen-fp8"]);
recordRecipeOutcome(task.id, "04", "success");
recordRecipeOutcome(task.id, "02", "failed");

const efficacy = computeRecipeEfficacy();
console.log(`  Recipe efficacy report:`);
for (const r of efficacy) {
  const rate = `${(r.successRate * 100).toFixed(0)}%`;
  console.log(`    ${r.recipeId}: ${r.successCount}/${r.appliedCount} success (${rate}), failed=${r.failedCount}, last=${r.lastAppliedAt?.slice(0,10)}`);
}

// ── Step 9: verify the feedback event in SQLite ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log("\n━━━ Step 8: Verify feedback in SQLite ━━━");

// Read directly from the DB to confirm sync worked
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(dbPath);
const feedbackRows = db.prepare("SELECT type, severity, source, proposed_action FROM feedback WHERE task_id = ?").all(task.id) as any[];
db.close();

console.log(`  Feedback rows in SQLite: ${feedbackRows.length}`);
if (feedbackRows.length > 0) {
  for (const row of feedbackRows) {
    console.log(`    type=${row.type}, severity=${row.severity}, source=${row.source}, proposed=${row.proposed_action ?? "n/a"}`);
  }
}

closeDb();

// ── Cleanup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
await fs.rm(tmpRoot, { recursive: true, force: true });

// ── Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log("\n━━━ E2E Summary ━━━");
console.log("  ✓ FP8 workflow uploaded");
console.log(`  ${hasRecipe ? "✓" : "✗"} Recipe injected into Step 02 prompt (hard layer)`);
console.log(`  ${hasSkill ? "✓" : "✗"} FP8 skill injected into Step 02 prompt (soft layer)`);
console.log(`  ${hasAttnSkill ? "✓" : "✗"} Attention skill injected into Step 04 prompt`);
console.log(`  ${hasSeedvr2Skill ? "✓" : "✗"} SeedVR2 skill injected into Step 04 prompt`);
console.log(`  ${events.length > 0 ? "✓" : "✗"} Feedback event auto-collected on hard-stop`);
console.log(`  ${clipEfficacy ? "✓" : "✗"} Recipe usage tracked in analytics DB`);
console.log(`  ${syncStats.synced > 0 ? "✓" : "✗"} Feedback synced JSONL → SQLite`);
console.log(`  ${efficacy.length > 0 ? "✓" : "✗"} Recipe efficacy queryable`);
console.log("");
