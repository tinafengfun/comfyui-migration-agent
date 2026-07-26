/**
 * apply-agent-improvements.mts — CLI wrapper around
 * src/server/agentImprovementPipeline.ts's draftImprovement/fixImprovement.
 * See that module for the actual isolated-worktree logic and safety
 * rationale (never touches main, never pushes/merges).
 *
 * This is stage (a) of the generate -> verify -> merge pipeline:
 *   apply-agent-improvements.mts (this file, "drafted")
 *     -> verify-agent-improvement.mts ("verified" / "verification_failed")
 *     -> merge-agent-improvement.mts ("applied", local merge only; push/deploy
 *        stay separate, explicit, human-triggered actions)
 *
 * --fix mode: re-invoked on an item already at "verification_failed" (real
 * failures found by verify-agent-improvement.mts). Reuses the SAME
 * disposable worktree/branch and hands the SDK session the actual failing
 * command + stderr from the last verification run.
 *
 * Usage:
 *   npx tsx scripts/apply-agent-improvements.mts --task <taskId> [--item <id>] [--api http://127.0.0.1:3001]
 *   npx tsx scripts/apply-agent-improvements.mts --task <taskId> --item <id> --fix [--api http://127.0.0.1:3001]
 */
import { loadConfig } from "../src/server/config";
import { CopilotSdkRunner } from "../src/server/copilotSdkRunner";
import { draftImprovement, fixImprovement } from "../src/server/agentImprovementPipeline";
import { applyItemPatches, readAgentImprovementFile, writeAgentImprovementFile } from "../src/server/agentImprovementPatch";
import path from "node:path";

const API = argValue("--api") ?? process.env.PW_API ?? "http://127.0.0.1:3001";
const taskId = argValue("--task");
const onlyItemId = argValue("--item");
const fixMode = process.argv.includes("--fix");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!taskId) {
    console.error("usage: apply-agent-improvements.mts --task <taskId> [--item <id>] [--api URL]");
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
    console.error(`No 13-agent-improvement.json found at ${filePath} -- has Step 13 run for this task?`);
    process.exit(1);
  }

  const expectedStatus = fixMode ? "verification_failed" : "approved_to_apply";
  const candidates = state.improvements.filter(
    (item) => item.apply_status === expectedStatus && (!onlyItemId || item.id === onlyItemId)
  );
  if (candidates.length === 0) {
    console.log(
      onlyItemId
        ? `Item ${onlyItemId} isn't ${expectedStatus} (or doesn't exist). Nothing to do.`
        : `No items are ${expectedStatus}. Nothing to do.`
    );
    return;
  }
  if (fixMode && !onlyItemId) {
    console.error("--fix requires --item (fix one item at a time, deliberately).");
    process.exit(2);
  }

  const config = loadConfig();
  const runner = new CopilotSdkRunner(config);
  const repoRoot = config.projectRoot;

  for (const item of candidates) {
    console.log(`\n=== ${fixMode ? "Fixing" : "Applying"} ${item.id} ===`);
    if (fixMode && !item.draft) {
      console.error(`  ${item.id} has no draft info -- can't fix in-place, run without --fix first.`);
      continue;
    }
    try {
      const result = fixMode
        ? await fixImprovement({
            repoRoot,
            sdkRunner: runner,
            item: item as typeof item & { draft: NonNullable<typeof item.draft> },
            sourceTaskArtifactPath: task.artifactPath,
            log: console.log
          })
        : await draftImprovement({
            repoRoot,
            sdkRunner: runner,
            item,
            sourceTaskArtifactPath: task.artifactPath,
            log: console.log
          });

      console.log(`  Review: cd ${result.worktreePath} && git log -p -1`);
      console.log("  Nothing has been pushed or merged to main. Run scripts/verify-agent-improvement.mts next.");

      const nextStatus = result.madeChanges ? "drafted" : "verification_failed";
      const current = (await readAgentImprovementFile(filePath))!;
      const { state: updated, unmatchedIds } = applyItemPatches(current, {
        [item.id]: {
          apply_status: nextStatus,
          ...(result.madeChanges && result.commitSha
            ? { draft: { branch: result.branch, worktreePath: result.worktreePath, commitSha: result.commitSha } }
            : {})
        }
      });
      if (unmatchedIds.length > 0) {
        console.error(`  WARNING: could not record status update, unmatched id(s): ${unmatchedIds.join(", ")}`);
      } else {
        await writeAgentImprovementFile(filePath, updated);
        console.log(`  ${item.id} marked ${nextStatus} in ${filePath}.`);
      }
    } catch (error) {
      console.error(`  FAILED ${fixMode ? "fixing" : "applying"} ${item.id}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
