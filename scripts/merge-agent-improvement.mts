/**
 * merge-agent-improvement.mts -- stage (e) of the generate -> verify -> merge
 * pipeline for Step 13 agent self-improvements. Only operates on items at
 * apply_status "verified" (set by verify-agent-improvement.mts). This is the
 * final human-triggered action that actually lands a change on main -- it is
 * NEVER invoked automatically by anything else in this pipeline.
 *
 * What it does, in order, for each verified item:
 *   1. `git merge --no-ff <item's disposable branch>` into this repo's
 *      current branch (expected to be `main`) -- local only.
 *   2. Runs the full existing check sequence on the merged result:
 *      `npx tsc --noEmit -p .` then `npx vitest run`. If either fails, the
 *      merge commit is reverted (`git reset --hard` back to the pre-merge
 *      commit) and the item is left at "verified" (not "applied") so nothing
 *      broken ever lands even locally.
 *   3. Marks the item "applied" in 13-agent-improvement.json.
 *   4. Prints (and only prints -- never runs) the exact `git push origin
 *      main` command, UNLESS invoked with an explicit `--push` flag, which
 *      the operator must pass deliberately each time. This mirrors this
 *      session's established norm of never pushing without an explicit
 *      per-instance request, and the project's own rule that nothing
 *      touching the agent's own control surface is ever self-merged/pushed
 *      by the agent without a human asking for that specific action.
 *   5. Deploying (sync + restart the live agent-demo) is a SEPARATE step --
 *      see scripts/deploy-agent-demo.sh. This script never runs it.
 *
 * Usage:
 *   npx tsx scripts/merge-agent-improvement.mts --task <taskId> --item <id> [--push] [--api http://127.0.0.1:3001]
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../src/server/config";
import { applyItemPatches, readAgentImprovementFile, writeAgentImprovementFile } from "../src/server/agentImprovementPatch";

const execFileAsync = promisify(execFile);

const API = argValue("--api") ?? process.env.PW_API ?? "http://127.0.0.1:3001";
const taskId = argValue("--task");
const itemId = argValue("--item");
const shouldPush = process.argv.includes("--push");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function runCheck(repoRoot: string, label: string, command: string, args: string[]): Promise<boolean> {
  console.log(`  running ${label}...`);
  try {
    await execFileAsync(command, args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    console.log(`  ${label}: PASS`);
    return true;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    console.error(`  ${label}: FAIL`);
    console.error((err.stdout ?? "").slice(-4000));
    console.error((err.stderr ?? err.message ?? String(error)).slice(-4000));
    return false;
  }
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
  const { branch } = item.draft;

  const preMergeSha = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  console.log(`\n=== Merging ${itemId} (branch ${branch}) into ${repoRoot} ===`);
  console.log(`  pre-merge HEAD: ${preMergeSha}`);

  await git(repoRoot, ["merge", "--no-ff", branch, "-m", `Merge agent-improvement/${itemId}`]);
  const mergeSha = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  console.log(`  merged locally as ${mergeSha}`);

  const typecheckOk = await runCheck(repoRoot, "tsc --noEmit", "npx", ["tsc", "--noEmit", "-p", "."]);
  const testsOk = typecheckOk && (await runCheck(repoRoot, "vitest run", "npx", ["vitest", "run"]));

  if (!typecheckOk || !testsOk) {
    console.error(`  reverting merge -- checks failed. Resetting ${repoRoot} back to ${preMergeSha}.`);
    await git(repoRoot, ["reset", "--hard", preMergeSha]);
    console.error(`  ${itemId} left at "verified" -- nothing landed even locally. Investigate the failure before retrying.`);
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
    console.log(`\n  Merged locally only. To publish, review the merge commit (${mergeSha}) and run:`);
    console.log(`    cd ${repoRoot} && git push origin main`);
  }
  console.log(`\n  Deployment (sync + restart the live agent-demo) is a separate step: scripts/deploy-agent-demo.sh`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
