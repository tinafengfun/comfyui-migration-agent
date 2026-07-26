/**
 * merge-agent-improvement.mts — CLI wrapper around
 * src/server/agentImprovementPipeline.ts's mergeImprovement(). See that
 * module for the local-merge + tsc/vitest + auto-revert logic. This is the
 * final human-triggered action that actually lands a change on main -- it
 * is NEVER invoked automatically by anything else in this pipeline.
 *
 * Push to origin stays a separate, explicit `--push` flag the operator must
 * pass deliberately each time -- mirrors this project's rule that nothing
 * touching the agent's own control surface is ever self-merged/pushed by
 * the agent without a human asking for that specific action. Deploying
 * (sync + restart agent-demo) is a further separate step:
 * scripts/deploy-agent-demo.sh.
 *
 * Usage:
 *   npx tsx scripts/merge-agent-improvement.mts --task <taskId> --item <id> [--push] [--api http://127.0.0.1:3001]
 */
import path from "node:path";
import { loadConfig } from "../src/server/config";
import { mergeImprovement, git } from "../src/server/agentImprovementPipeline";
import { applyItemPatches, readAgentImprovementFile, writeAgentImprovementFile } from "../src/server/agentImprovementPatch";

const API = argValue("--api") ?? process.env.PW_API ?? "http://127.0.0.1:3001";
const taskId = argValue("--task");
const itemId = argValue("--item");
const shouldPush = process.argv.includes("--push");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!taskId || !itemId) {
    console.error("usage: merge-agent-improvement.mts --task <taskId> --item <id> [--push] [--api URL]");
    process.exit(2);
  }

  const res = await fetch(`${API}/api/tasks/${taskId}`);
  if (!res.ok) {
    console.error(`task ${taskId} -> HTTP ${res.status}`);
    process.exit(1);
  }
  const { task } = (await res.json()) as { task: { id: string; artifactPath: string } };
  const filePath = path.join(task.artifactPath, "13-agent-improvement.json");
  const state = await readAgentImprovementFile(filePath);
  if (!state) {
    console.error(`No 13-agent-improvement.json found at ${filePath}.`);
    process.exit(1);
  }

  const item = state.improvements.find((i) => i.id === itemId);
  if (!item) {
    console.error(`Item ${itemId} not found.`);
    process.exit(1);
  }
  if (item.apply_status !== "verified" && item.apply_status !== "awaiting_merge_review") {
    console.error(`Item ${itemId} is "${item.apply_status}", not "verified" -- run verify-agent-improvement.mts first. Refusing to merge unverified changes.`);
    process.exit(1);
  }
  if (!item.draft) {
    console.error(`Item ${itemId} has no draft info (branch/worktreePath) -- nothing to merge.`);
    process.exit(1);
  }

  const config = loadConfig();
  const repoRoot = config.projectRoot;

  const result = await mergeImprovement({
    repoRoot,
    item: item as typeof item & { draft: NonNullable<typeof item.draft> },
    log: console.log
  });

  if (!result.ok) {
    console.error(`  ${itemId} left at "verified" -- nothing landed even locally: ${result.reason}`);
    process.exit(1);
  }

  const current = (await readAgentImprovementFile(filePath))!;
  const { state: updated, unmatchedIds } = applyItemPatches(current, {
    [itemId]: { apply_status: "applied" }
  });
  if (unmatchedIds.length > 0) {
    console.error(`  WARNING: could not record status update, unmatched id(s): ${unmatchedIds.join(", ")}`);
  } else {
    await writeAgentImprovementFile(filePath, updated);
    console.log(`  ${itemId} marked applied in ${filePath}.`);
  }

  if (shouldPush) {
    console.log("  --push passed: pushing to origin main...");
    await git(repoRoot, ["push", "origin", "HEAD"]);
    console.log("  pushed.");
  } else {
    console.log(`\n  Merged locally only. To publish, review the merge commit (${result.mergeSha}) and run:`);
    console.log(`    cd ${repoRoot} && git push origin main`);
  }
  console.log(`\n  Deployment (sync + restart the live agent-demo) is a separate step: scripts/deploy-agent-demo.sh`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
