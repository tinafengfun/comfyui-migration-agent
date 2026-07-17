/**
 * patch-task-state.mts — safely persist a step's completion entry into a
 * task's `artifacts/task-state.json` ledger.
 *
 * Every per-step migration SDK session is instructed (agent.md's Common
 * Migration Contract) to maintain this file itself, with no deterministic
 * backend write path -- a real run corrupted it: Step 13's entry landed
 * outside the `steps` array with an orphaned extra `]`, because completing
 * the terminal step requires touching both the array's last element and
 * top-level fields after it in one edit. Use this tool instead of hand-editing
 * the JSON text; it always produces valid JSON, auto-repairs the one confirmed
 * prior corruption shape if it finds it, and refuses to proceed (loudly) if
 * the existing file is unparseable and unrecognized.
 *
 * Usage:
 *   npx tsx scripts/patch-task-state.mts --artifacts <artifactDir> \
 *     --step-file <path-to-json-file-with-the-step-object> \
 *     [--top-level-file <path-to-json-file-with-root-field-updates>]
 *
 * The step-file's JSON must include a "step" (or legacy "stepId") field, e.g.:
 *   {"step": "13", "name": "Agent improvement", "status": "completed", ...}
 */
import fs from "node:fs";
import path from "node:path";
import { applyStepPatch, parseTaskStateWithRepair } from "../src/server/taskStatePatch";

const artifactsDir = argValue("--artifacts");
const stepFilePath = argValue("--step-file");
const topLevelFilePath = argValue("--top-level-file");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  if (!artifactsDir || !stepFilePath) {
    console.error(
      "usage: patch-task-state.mts --artifacts <dir> --step-file <path.json> [--top-level-file <path.json>]"
    );
    process.exit(2);
  }

  const taskStatePath = path.join(artifactsDir, "task-state.json");
  const stepPatch = JSON.parse(fs.readFileSync(stepFilePath, "utf8"));
  const topLevelPatch = topLevelFilePath ? JSON.parse(fs.readFileSync(topLevelFilePath, "utf8")) : undefined;

  let state: Record<string, unknown> = {};
  if (fs.existsSync(taskStatePath)) {
    const raw = fs.readFileSync(taskStatePath, "utf8");
    if (raw.trim() !== "") {
      const { state: parsed, repaired } = parseTaskStateWithRepair(raw);
      state = parsed;
      if (repaired) {
        console.log(`[patch-task-state] auto-repaired a corrupted ${taskStatePath} before applying this patch`);
      }
    }
  }

  const next = applyStepPatch(state, stepPatch, topLevelPatch);

  const tempPath = `${taskStatePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(taskStatePath), { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, taskStatePath);

  // Re-validate: the tool must never leave the file invalid.
  const verify = fs.readFileSync(taskStatePath, "utf8");
  JSON.parse(verify);

  console.log(`[patch-task-state] wrote ${taskStatePath} (${(next.steps as unknown[])?.length ?? 0} step entries)`);
}

main();
