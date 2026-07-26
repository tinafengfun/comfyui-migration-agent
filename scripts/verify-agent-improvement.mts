/**
 * verify-agent-improvement.mts — CLI wrapper around
 * src/server/agentImprovementPipeline.ts's verifyImprovement(). See that
 * module for the actual validation-command + optional-replay logic and
 * safety rationale (never touches main, never touches the live task's own
 * StateStore).
 *
 * Usage:
 *   npx tsx scripts/verify-agent-improvement.mts --task <taskId> [--item <id>] [--replay] [--api http://127.0.0.1:3001]
 */
import path from "node:path";
import { verifyImprovement } from "../src/server/agentImprovementPipeline";
import {
  applyItemPatches,
  readAgentImprovementFile,
  writeAgentImprovementFile,
  type AgentImprovementVerification
} from "../src/server/agentImprovementPatch";

const API = argValue("--api") ?? process.env.PW_API ?? "http://127.0.0.1:3001";
const taskId = argValue("--task");
const onlyItemId = argValue("--item");
const attemptReplay = process.argv.includes("--replay");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!taskId) {
    console.error("usage: verify-agent-improvement.mts --task <taskId> [--item <id>] [--replay] [--api URL]");
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

  const candidates = state.improvements.filter(
    (item) => item.apply_status === "drafted" && (!onlyItemId || item.id === onlyItemId)
  );
  if (candidates.length === 0) {
    console.log(onlyItemId ? `Item ${onlyItemId} isn't "drafted" (or doesn't exist). Nothing to do.` : "No items are drafted. Nothing to do.");
    return;
  }

  for (const item of candidates) {
    console.log(`\n=== Verifying ${item.id} ===`);
    if (!item.draft) {
      console.error(`  no draft info recorded for ${item.id} -- was apply-agent-improvements.mts run for it?`);
      await patchItem(filePath, item.id, "verification_failed", {
        ranAt: new Date().toISOString(),
        validationResults: [],
        passed: false
      });
      continue;
    }

    const { verification, passed } = await verifyImprovement({
      item: item as typeof item & { draft: NonNullable<typeof item.draft> },
      sourceTaskId: taskId,
      api: API,
      attemptReplay,
      log: console.log
    });
    await patchItem(filePath, item.id, passed ? "verified" : "verification_failed", verification);
    console.log(`  ${item.id} -> ${passed ? "verified" : "verification_failed"}`);
  }
}

async function patchItem(filePath: string, itemId: string, applyStatus: string, verification: AgentImprovementVerification): Promise<void> {
  const current = (await readAgentImprovementFile(filePath))!;
  const { state: updated, unmatchedIds } = applyItemPatches(current, {
    [itemId]: { apply_status: applyStatus, verification }
  });
  if (unmatchedIds.length > 0) {
    console.error(`  WARNING: could not record status update, unmatched id(s): ${unmatchedIds.join(", ")}`);
    return;
  }
  await writeAgentImprovementFile(filePath, updated);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
