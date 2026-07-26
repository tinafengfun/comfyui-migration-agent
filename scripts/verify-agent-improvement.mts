/**
 * verify-agent-improvement.mts -- stage (c)+(d) of the generate -> verify ->
 * merge pipeline for Step 13 agent self-improvements. Never touches main,
 * never pushes, never touches the live deployment or the live task's own
 * StateStore -- everything here runs against the disposable worktree
 * apply-agent-improvements.mts already created, plus (for --replay) a
 * throwaway scratch orchestrator instance in a temp directory.
 *
 * For each item at apply_status "drafted":
 *   1. Run the concrete validation commands apply-agent-improvements.mts's
 *      SDK session already resolved into `.agent-improvement-validate.json`
 *      at the worktree root (the item's own `required_validation` entries
 *      are human-readable templates like "<03-inventory.md>", not literal
 *      commands -- resolving placeholders happens once, at draft time, by
 *      the same session that made the edit and knows the real file paths).
 *      Each command runs via `bash -c` from the worktree root; exit code 0
 *      = passed. Real fixture data, not synthetic: the source task's own
 *      artifact folder (e.g. `03-inventory.md`, `10-node-coverage.csv`) is
 *      genuine ground truth from a run that already happened.
 *   2. Only with --replay (off by default -- a replay can trigger real
 *      Step 05+ environment/GPU work if the target step is downstream of
 *      those, so this stays an explicit, deliberate action): if every one
 *      of the item's target_files lives under prompts/ or skills/ (a tool
 *      script change can't be verified by replay -- the SDK doesn't re-read
 *      .py files as instructions), spin up a fully isolated
 *      MigrationOrchestrator (scratch StateStore/workspace/state root,
 *      draftDocRoot pointed at the worktree's own prompts/ dir) and replay
 *      the source task's workflow through it, auto-injecting the source
 *      task's own recorded human decisions (mirrors the existing
 *      `POST /api/tasks/:taskId/replay` endpoint's logic exactly, just
 *      pointed at the worktree's code instead of the live deployment).
 *
 * Writes results to item.verification and sets apply_status to "verified"
 * or "verification_failed" via agentImprovementPatch.ts's safe
 * read-modify-write helpers.
 *
 * Usage:
 *   npx tsx scripts/verify-agent-improvement.mts --task <taskId> [--item <id>] [--replay] [--api http://127.0.0.1:3001]
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../src/server/config";
import { loadStepDefinitions } from "../src/server/workflowLoader";
import { MigrationOrchestrator } from "../src/server/orchestrator";
import { StateStore } from "../src/server/state";
import { ensureDir } from "../src/server/fsUtils";
import {
  applyItemPatches,
  readAgentImprovementFile,
  writeAgentImprovementFile,
  type AgentImprovementItem,
  type AgentImprovementValidationResult,
  type AgentImprovementReplayResult
} from "../src/server/agentImprovementPatch";

const execFileAsync = promisify(execFile);

const API = argValue("--api") ?? process.env.PW_API ?? "http://127.0.0.1:3001";
const taskId = argValue("--task");
const onlyItemId = argValue("--item");
const attemptReplay = process.argv.includes("--replay");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readValidateCommands(worktreePath: string): Promise<string[]> {
  const filePath = path.join(worktreePath, ".agent-improvement-validate.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { commands?: unknown };
    if (!Array.isArray(parsed.commands)) return [];
    return parsed.commands.filter((c): c is string => typeof c === "string");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.error(`  WARNING: .agent-improvement-validate.json exists but couldn't be parsed: ${error}`);
    return [];
  }
}

async function runValidationCommand(worktreePath: string, command: string): Promise<AgentImprovementValidationResult> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
      cwd: worktreePath,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5 * 60 * 1000
    });
    return { command, exitCode: 0, stdout, stderr, passed: true };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      command,
      exitCode: typeof err.code === "number" ? err.code : null,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? String(error),
      passed: false
    };
  }
}

/** Only prompt/skill changes are replayable -- a .py tool edit isn't "read" by the SDK as instructions. */
function isReplayEligible(item: AgentImprovementItem): boolean {
  const files = item.target_files ?? [];
  if (files.length === 0) return false;
  return files.every((f) => f.includes("/prompts/") || f.includes("/skills/") || f.startsWith("prompts/") || f.startsWith("skills/"));
}

async function runScopedReplay(input: {
  worktreePath: string;
  sourceTaskId: string;
  api: string;
}): Promise<AgentImprovementReplayResult> {
  const { worktreePath, sourceTaskId, api } = input;
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-improvement-verify-"));
  try {
    const res = await fetch(`${api}/api/tasks/${sourceTaskId}`);
    if (!res.ok) return { ranReplay: false, reason: `source task fetch failed: HTTP ${res.status}` };
    const { task: sourceTask } = (await res.json()) as {
      task: { id: string; workflowPath: string; artifactPath: string };
    };
    const workflowJson = JSON.parse(await fs.readFile(sourceTask.workflowPath, "utf8"));

    const decisionsRes = await fetch(`${api}/api/tasks/${sourceTaskId}/human-decisions`);
    const sourceDecisions = decisionsRes.ok ? ((await decisionsRes.json()) as { decisions: unknown[] }).decisions : [];

    const draftDocRoot = path.join(worktreePath, "prompts");
    if (
      !(await fs
        .stat(draftDocRoot)
        .then((s) => s.isDirectory())
        .catch(() => false))
    ) {
      return { ranReplay: false, reason: `worktree has no prompts/ dir at ${draftDocRoot}` };
    }

    const scratchConfig = {
      ...loadConfig(),
      projectRoot: scratchRoot,
      workspaceRoot: path.join(scratchRoot, "workspaces"),
      stateRoot: path.join(scratchRoot, ".demo-state"),
      draftDocRoot,
      gpuNodesPath: path.join(scratchRoot, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(scratchRoot, "nfs-workflows")
    };
    await ensureDir(scratchConfig.workspaceRoot);

    const steps = await loadStepDefinitions(scratchConfig);
    const store = new StateStore(scratchConfig);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(scratchConfig, store, steps);

    const replayTask = await orchestrator.createTask({
      name: `verify-replay-${sourceTaskId}`,
      workflowFileName: path.basename(sourceTask.workflowPath),
      workflowJson
    });

    if (Array.isArray(sourceDecisions) && sourceDecisions.length > 0) {
      await fs.writeFile(
        path.join(replayTask.artifactPath, "replay-decisions.json"),
        JSON.stringify({ sourceTaskId, decisions: sourceDecisions }),
        "utf8"
      );
    }

    await orchestrator.runUntilGate(replayTask.id);

    const finalTask = await store.getTask(replayTask.id);
    const hasFailure = finalTask?.steps.some((s) => s.status === "failed" || s.status === "hard_stopped");
    return {
      ranReplay: true,
      taskId: replayTask.id,
      stepStatus: finalTask?.status,
      hardStopped: Boolean(hasFailure)
    };
  } catch (error) {
    return { ranReplay: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }
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

    const { worktreePath } = item.draft;
    const commands = await readValidateCommands(worktreePath);
    console.log(`  ${commands.length} validation command(s) to run`);
    const validationResults: AgentImprovementValidationResult[] = [];
    for (const command of commands) {
      console.log(`  $ ${command}`);
      const result = await runValidationCommand(worktreePath, command);
      validationResults.push(result);
      console.log(`    ${result.passed ? "PASS" : "FAIL"} (exit ${result.exitCode ?? "null"})`);
      if (!result.passed) console.log(`    stderr: ${result.stderr.split("\n").slice(0, 10).join("\n    ")}`);
    }

    let replayResult: AgentImprovementReplayResult | undefined;
    if (attemptReplay && isReplayEligible(item)) {
      console.log("  running scoped replay (--replay)...");
      replayResult = await runScopedReplay({ worktreePath, sourceTaskId: taskId, api: API });
      console.log(`  replay: ${replayResult.ranReplay ? `ran, task ${replayResult.taskId} ended at ${replayResult.stepStatus}` : `skipped/failed -- ${replayResult.reason}`}`);
    } else if (isReplayEligible(item)) {
      console.log("  item touches prompts/skills but --replay wasn't passed -- skipping behavioral replay (validation commands only).");
    }

    const passed =
      validationResults.every((r) => r.passed) && (!replayResult || (replayResult.ranReplay && !replayResult.hardStopped));
    await patchItem(filePath, item.id, passed ? "verified" : "verification_failed", {
      ranAt: new Date().toISOString(),
      validationResults,
      ...(replayResult ? { replayResult } : {}),
      passed
    });
    console.log(`  ${item.id} -> ${passed ? "verified" : "verification_failed"}`);
  }
}

async function patchItem(
  filePath: string,
  itemId: string,
  applyStatus: string,
  verification: import("../src/server/agentImprovementPatch").AgentImprovementVerification
): Promise<void> {
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
