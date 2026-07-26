/**
 * agentImprovementPipeline.ts -- shared draft/verify/fix/merge logic for
 * Step 13 agent self-improvements, used by BOTH the standalone CLI scripts
 * (scripts/apply-agent-improvements.mts, verify-agent-improvement.mts,
 * merge-agent-improvement.mts -- thin argv wrappers around this module) and
 * orchestrator.ts's in-process multi-round Step 13 flow. Extracted so both
 * call sites share one tested implementation instead of drifting.
 *
 * None of these functions read or write 13-agent-improvement.json directly
 * -- callers own that (via agentImprovementPatch.ts's safe read-modify-write
 * helpers) so the same functions work whether the caller is a one-shot CLI
 * invocation or an in-process loop across several items.
 *
 * IMPORTANT: `repoRoot` here must be the canonical comfyui-migration-agent
 * checkout, never `config.projectRoot` of a live agent-demo process -- that
 * path can be a stale subtree of a completely different repo (confirmed
 * live this session: agent-demo's own git identity is the ComfyUI repo's
 * `v2-agent` branch, badly behind comfyui-migration-agent's actual history).
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config";
import type { CopilotSdkRunner } from "./copilotSdkRunner";
import { loadStepDefinitions } from "./workflowLoader";
import { MigrationOrchestrator } from "./orchestrator";
import { StateStore } from "./state";
import { ensureDir } from "./fsUtils";
import type {
  AgentImprovementItem,
  AgentImprovementValidationResult,
  AgentImprovementReplayResult,
  AgentImprovementVerification
} from "./agentImprovementPatch";

const execFileAsync = promisify(execFile);

/**
 * Per-item validate-commands file and helper-script directory names.
 * Confirmed live: a shared, non-item-scoped name (".agent-improvement-validate.json"
 * for every item) caused a real add/add merge conflict the first time two
 * items' disposable branches were merged into main back to back -- each
 * branch independently created a file with the identical path. Scoping by
 * item id makes that class of collision structurally impossible.
 */
export function validateCommandsFile(itemId: string): string {
  return `.agent-improvement-validate.${sanitizeForFilename(itemId)}.json`;
}
export function validateHelpersDir(itemId: string): string {
  return `.agent-improvement-validate-helpers/${sanitizeForFilename(itemId)}`;
}
function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export type FreeformSessionRunner = { runFreeformSession: CopilotSdkRunner["runFreeformSession"] };
export type Logger = (message: string) => void;
const noopLog: Logger = () => {};

export async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage (a)/(fix): draft / fix
// ─────────────────────────────────────────────────────────────────────────

export interface DraftRunResult {
  madeChanges: boolean;
  branch: string;
  worktreePath: string;
  commitSha?: string;
  sdkSummary?: string;
}

function buildDraftPrompt(item: AgentImprovementItem, sourceTaskArtifactPath: string): string {
  const targetFiles = (item.target_files ?? []).join("\n  - ");
  const validation = (item.required_validation ?? []).map((v) => `  - ${v}`).join("\n") || "  (none specified)";
  const validateFile = validateCommandsFile(item.id);
  const helpersDir = validateHelpersDir(item.id);
  return [
    `You are applying ONE human-approved improvement to this ComfyUI migration agent's own repo.`,
    `This is not a ComfyUI migration step -- you are editing the agent's own prompts/skills/scripts.`,
    "",
    `## Improvement ${item.id}`,
    "",
    `**Root cause:** ${item.root_cause ?? "(not provided)"}`,
    "",
    `**Proposed change:** ${item.proposed_change ?? "(not provided)"}`,
    "",
    `**Target files (only touch these):**`,
    `  - ${targetFiles || "(none listed -- infer conservatively from the proposed change and stop if unsure)"}`,
    "",
    `**Required validation (human-readable templates, not literal commands):**`,
    validation,
    "",
    `## After making the edit: write concrete validation commands`,
    `The task this improvement came from left its real artifacts at: ${sourceTaskArtifactPath}`,
    `(read-only -- do NOT modify anything there). Resolve each "Required validation" item above into an`,
    `actual, directly-runnable shell command by substituting its placeholder paths with real files from`,
    `that directory (e.g. <03-inventory.md> -> the real absolute path to that file in the artifact dir).`,
    `Write the resolved commands to ${validateFile} at the root of this worktree, as JSON:`,
    `  {"commands": ["<literal command 1>", "<literal command 2>", ...]}`,
    `IMPORTANT: this exact filename is scoped to THIS improvement specifically -- a different, shared`,
    `filename caused a real merge conflict the first time two improvements were merged back to back.`,
    `Do not rename it to something more generic.`,
    `Each command must be runnable via "bash -c" from this worktree's root with no further edits. If a`,
    `validation item genuinely isn't a runnable command (e.g. "re-read the skill and verify X"), omit it`,
    `from the JSON and instead note it in your final summary as something a human must check by reading.`,
    `If there is nothing runnable at all, still write ${validateFile} with an empty commands array.`,
    `If a check needs more than one Python statement or any control flow (for/if/loops), do NOT write a`,
    `"python3 -c ..." one-liner or a heredoc inline in the command string -- both are fragile to get right`,
    `and, worse, a heredoc's embedded newlines break ${validateFile}'s own JSON encoding (this has`,
    `happened for real). Instead write an actual small helper script file INSIDE this worktree, under`,
    `${helpersDir}/ (this directory is also scoped to THIS improvement -- for the same merge-conflict`,
    `reason, do not put helper scripts anywhere else), commit it alongside your other changes, and make`,
    `the command a single flat line with no embedded newlines: "python3 ${helpersDir}/check_foo.py".`,
    `Confirm ${validateFile} is valid JSON yourself (e.g. "python3 -m json.tool ${validateFile}") before finishing.`,
    "",
    "## Non-negotiable constraints",
    "- Only modify the files listed in \"Target files\" above (plus the new validate-commands JSON file). If the change genuinely requires touching an unlisted file, stop and explain why instead of proceeding.",
    "- Do NOT run `git commit`, `git push`, `git merge`, or any command that changes git history or branches. You are in a disposable worktree; a human reviews and merges separately.",
    "- Do NOT touch task-state.json, any workspaces/ directory, or any other task's artifacts -- read from the source task's artifact path above, never write to it.",
    "- Keep the change minimal and scoped to exactly this improvement -- do not refactor unrelated content.",
    "- When done, summarize exactly what you changed and why in your final response."
  ].join("\n");
}

function buildFixPrompt(item: AgentImprovementItem, sourceTaskArtifactPath: string): string {
  const targetFiles = (item.target_files ?? []).join("\n  - ");
  const failures = (item.verification?.validationResults ?? []).filter((r) => !r.passed);
  const failureBlock =
    failures
      .map(
        (f, i) =>
          `### Failure ${i + 1}\nCommand: ${f.command}\nExit code: ${f.exitCode}\nStderr:\n\`\`\`\n${f.stderr.slice(0, 4000)}\n\`\`\``
      )
      .join("\n\n") || "(no failed validation commands recorded -- check item.verification manually)";
  const validateFile = validateCommandsFile(item.id);
  const helpersDir = validateHelpersDir(item.id);
  return [
    `You are fixing a real, verified failure in an already-drafted agent improvement, in the SAME`,
    `disposable git branch/worktree you (or an earlier session) already committed to. Do not start over --`,
    `read the existing code in this worktree first, understand what's already there, then fix only what's`,
    `broken.`,
    "",
    `## Improvement ${item.id}`,
    "",
    `**Root cause:** ${item.root_cause ?? "(not provided)"}`,
    "",
    `**Proposed change:** ${item.proposed_change ?? "(not provided)"}`,
    "",
    `**Target files (only touch these, plus ${validateFile} if the fix is there instead):**`,
    `  - ${targetFiles || "(none listed)"}`,
    "",
    `## What actually failed when this was verified for real`,
    "",
    failureBlock,
    "",
    `Fix the root cause of each failure above. If the bug is in the target file(s) themselves, fix the`,
    `target file. If the bug is only in ${validateFile}'s own auxiliary validation command (not`,
    `the actual improvement), fix that file instead -- don't touch the target files for a bug that's only`,
    `in your own throwaway validation script. The source task's real artifacts are (read-only) at:`,
    `${sourceTaskArtifactPath}`,
    "",
    `If the fix involves a multi-line/multi-statement check, write it as an actual helper script file in`,
    `this worktree, under ${helpersDir}/, and reference it with a single flat command -- do NOT embed a`,
    `heredoc or multi-line script inline in ${validateFile}'s command string; its embedded newlines will`,
    `corrupt that file's own JSON encoding (this has happened for real). Confirm ${validateFile} is valid`,
    `JSON yourself before finishing, e.g.:`,
    `  python3 -m json.tool ${validateFile}`,
    "",
    "## Non-negotiable constraints",
    "- Only modify the files listed in \"Target files\" above and/or " + validateFile + ".",
    "- Do NOT run `git commit`, `git push`, `git merge`, or any command that changes git history or branches.",
    "- Do NOT touch task-state.json, any workspaces/ directory, or any other task's artifacts.",
    "- After fixing, re-run the validation command(s) yourself to confirm the fix actually works before finishing.",
    "- When done, summarize exactly what was wrong and what you changed to fix it."
  ].join("\n");
}

async function runDraftOrFixSession(input: {
  repoRoot: string;
  sdkRunner: FreeformSessionRunner;
  item: AgentImprovementItem;
  sourceTaskArtifactPath: string;
  mode: "draft" | "fix";
  branchName: string;
  worktreePath: string;
  log: Logger;
}): Promise<DraftRunResult> {
  const { sdkRunner, item, sourceTaskArtifactPath, mode, branchName, worktreePath, log } = input;
  const prompt = mode === "fix" ? buildFixPrompt(item, sourceTaskArtifactPath) : buildDraftPrompt(item, sourceTaskArtifactPath);
  const result = await sdkRunner.runFreeformSession({
    cwd: worktreePath,
    prompt,
    sessionId: `${mode}-${item.id}-${Date.now()}`,
    onProgress: (message) => log(`  [sdk] ${message}`)
  });
  log(`  SDK session summary:\n${(result.summary ?? "(no summary)").split("\n").map((l) => `    ${l}`).join("\n")}`);

  const status = await git(worktreePath, ["status", "--porcelain"]);
  let commitSha: string | undefined = item.draft?.commitSha;
  const madeChanges = Boolean(status.trim());
  if (!madeChanges) {
    log(mode === "fix" ? "  WARNING: fix session made no changes -- the failure is still unresolved." : "  WARNING: no changes were made in the worktree.");
  } else {
    await git(worktreePath, ["add", "-A"]);
    const diffStat = await git(worktreePath, ["diff", "--cached", "--stat"]);
    log(`  diff --stat (staged):\n${diffStat.split("\n").map((l) => `    ${l}`).join("\n")}`);
    // Commit deterministically here (not left to the SDK session -- the
    // prompt explicitly forbids it from running git commit) so the
    // review/verify stages have a real commit object to point at instead
    // of "staged, uncommitted" state. Still confined to the disposable
    // branch -- no different in risk from staging; nothing touches main.
    const commitMessage =
      mode === "fix"
        ? [`fix: ${item.id} verification failures`, "", `See prior item.verification.validationResults for what failed.`].join("\n")
        : [
            `agent-improvement: ${item.id}`,
            "",
            `Root cause: ${item.root_cause ?? "(not provided)"}`,
            "",
            `Proposed change: ${item.proposed_change ?? "(not provided)"}`
          ].join("\n");
    await git(worktreePath, ["commit", "-m", commitMessage]);
    commitSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
    log(`  committed to disposable branch ${branchName} as ${commitSha}`);
  }
  return { madeChanges, branch: branchName, worktreePath, commitSha, sdkSummary: result.summary };
}

/** Stage (a): create a fresh disposable worktree/branch and draft the change. */
export async function draftImprovement(input: {
  repoRoot: string;
  sdkRunner: FreeformSessionRunner;
  item: AgentImprovementItem;
  sourceTaskArtifactPath: string;
  log?: Logger;
}): Promise<DraftRunResult> {
  const log = input.log ?? noopLog;
  const branchName = `apply-improvement/${input.item.id}-${Date.now()}`;
  const worktreePath = path.join(input.repoRoot, ".worktrees", `${input.item.id}-${Date.now()}`);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(input.repoRoot, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
  log(`  worktree created: ${worktreePath} (branch ${branchName})`);
  return runDraftOrFixSession({ ...input, log, mode: "draft", branchName, worktreePath });
}

/** Fix mode: reuse the SAME disposable worktree/branch an earlier draft already committed to. */
export async function fixImprovement(input: {
  repoRoot: string;
  sdkRunner: FreeformSessionRunner;
  item: AgentImprovementItem & { draft: NonNullable<AgentImprovementItem["draft"]> };
  sourceTaskArtifactPath: string;
  log?: Logger;
}): Promise<DraftRunResult> {
  const log = input.log ?? noopLog;
  const { branch: branchName, worktreePath } = input.item.draft;
  log(`  reusing existing worktree: ${worktreePath} (branch ${branchName})`);
  return runDraftOrFixSession({ ...input, log, mode: "fix", branchName, worktreePath });
}

// ─────────────────────────────────────────────────────────────────────────
// Stage (c)/(d): verify
// ─────────────────────────────────────────────────────────────────────────

/**
 * Distinguishes "no validate-commands file" (nothing to run -- fine, not a
 * failure) from "file exists but is corrupt" (a REAL failure -- must not
 * silently degrade to an empty command list, which would make
 * `validationResults.every(passed)` vacuously true on an empty array and
 * falsely report "verified" for something that was never actually checked).
 * Caught live: a fix session's heredoc-based validation command embedded a
 * raw, unescaped newline inside a JSON string value, corrupting the file --
 * without this distinction the corrupt file would have silently verified.
 */
export async function readValidateCommands(worktreePath: string, itemId: string): Promise<string[]> {
  const validateFile = validateCommandsFile(itemId);
  const filePath = path.join(worktreePath, validateFile);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as { commands?: unknown };
    if (!Array.isArray(parsed.commands)) return [];
    return parsed.commands.filter((c): c is string => typeof c === "string");
  } catch (error) {
    throw new Error(`${validateFile} exists but is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

export async function runValidationCommand(worktreePath: string, command: string): Promise<AgentImprovementValidationResult> {
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
export function isReplayEligible(item: AgentImprovementItem): boolean {
  const files = item.target_files ?? [];
  if (files.length === 0) return false;
  return files.every((f) => f.includes("/prompts/") || f.includes("/skills/") || f.startsWith("prompts/") || f.startsWith("skills/"));
}

export async function runScopedReplay(input: { worktreePath: string; sourceTaskId: string; api: string }): Promise<AgentImprovementReplayResult> {
  const { worktreePath, sourceTaskId, api } = input;
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-improvement-verify-"));
  try {
    const res = await fetch(`${api}/api/tasks/${sourceTaskId}`);
    if (!res.ok) return { ranReplay: false, reason: `source task fetch failed: HTTP ${res.status}` };
    const { task: sourceTask } = (await res.json()) as { task: { id: string; workflowPath: string; artifactPath: string } };
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
    return { ranReplay: true, taskId: replayTask.id, stepStatus: finalTask?.status, hardStopped: Boolean(hasFailure) };
  } catch (error) {
    return { ranReplay: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export interface VerifyRunResult {
  verification: AgentImprovementVerification;
  passed: boolean;
}

/** Stage (c)+(d): run the drafted item's own validation commands (+ optional replay). Never throws. */
export async function verifyImprovement(input: {
  item: AgentImprovementItem & { draft: NonNullable<AgentImprovementItem["draft"]> };
  sourceTaskId: string;
  api: string;
  attemptReplay?: boolean;
  log?: Logger;
}): Promise<VerifyRunResult> {
  const log = input.log ?? noopLog;
  const { worktreePath } = input.item.draft;

  let commands: string[];
  try {
    commands = await readValidateCommands(worktreePath, input.item.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`  ${message}`);
    return {
      passed: false,
      verification: {
        ranAt: new Date().toISOString(),
        validationResults: [{ command: `(read ${validateCommandsFile(input.item.id)})`, exitCode: null, stdout: "", stderr: message, passed: false }],
        passed: false
      }
    };
  }

  log(`  ${commands.length} validation command(s) to run`);
  const validationResults: AgentImprovementValidationResult[] = [];
  for (const command of commands) {
    log(`  $ ${command}`);
    const result = await runValidationCommand(worktreePath, command);
    validationResults.push(result);
    log(`    ${result.passed ? "PASS" : "FAIL"} (exit ${result.exitCode ?? "null"})`);
    if (!result.passed) log(`    stderr: ${result.stderr.split("\n").slice(0, 10).join("\n    ")}`);
  }

  let replayResult: AgentImprovementReplayResult | undefined;
  if (input.attemptReplay && isReplayEligible(input.item)) {
    log("  running scoped replay...");
    replayResult = await runScopedReplay({ worktreePath, sourceTaskId: input.sourceTaskId, api: input.api });
    log(`  replay: ${replayResult.ranReplay ? `ran, task ${replayResult.taskId} ended at ${replayResult.stepStatus}` : `skipped/failed -- ${replayResult.reason}`}`);
  } else if (isReplayEligible(input.item)) {
    log("  item touches prompts/skills but replay wasn't requested -- skipping behavioral replay (validation commands only).");
  }

  const passed = validationResults.every((r) => r.passed) && (!replayResult || (replayResult.ranReplay && !replayResult.hardStopped));
  return {
    passed,
    verification: { ranAt: new Date().toISOString(), validationResults, ...(replayResult ? { replayResult } : {}), passed }
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Stage (e): merge (local only -- push is a separate, explicit caller action)
// ─────────────────────────────────────────────────────────────────────────

export interface MergeRunResult {
  ok: boolean;
  mergeSha?: string;
  reason?: string;
}

async function runCheck(repoRoot: string, label: string, command: string, args: string[], log: Logger): Promise<boolean> {
  log(`  running ${label}...`);
  try {
    await execFileAsync(command, args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    log(`  ${label}: PASS`);
    return true;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    log(`  ${label}: FAIL`);
    log((err.stdout ?? "").slice(-4000));
    log((err.stderr ?? err.message ?? String(error)).slice(-4000));
    return false;
  }
}

/** Local `git merge --no-ff` + tsc/vitest gate, auto-reverting on failure. Never pushes. */
export async function mergeImprovement(input: {
  repoRoot: string;
  item: AgentImprovementItem & { draft: NonNullable<AgentImprovementItem["draft"]> };
  log?: Logger;
}): Promise<MergeRunResult> {
  const log = input.log ?? noopLog;
  const { repoRoot, item } = input;
  const { branch } = item.draft;

  const preMergeSha = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  log(`\n=== Merging ${item.id} (branch ${branch}) into ${repoRoot} ===`);
  log(`  pre-merge HEAD: ${preMergeSha}`);

  await git(repoRoot, ["merge", "--no-ff", branch, "-m", `Merge agent-improvement/${item.id}`]);
  const mergeSha = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  log(`  merged locally as ${mergeSha}`);

  const typecheckOk = await runCheck(repoRoot, "tsc --noEmit", "npx", ["tsc", "--noEmit", "-p", "."], log);
  const testsOk = typecheckOk && (await runCheck(repoRoot, "vitest run", "npx", ["vitest", "run"], log));

  if (!typecheckOk || !testsOk) {
    log(`  reverting merge -- checks failed. Resetting ${repoRoot} back to ${preMergeSha}.`);
    await git(repoRoot, ["reset", "--hard", preMergeSha]);
    return { ok: false, reason: !typecheckOk ? "tsc --noEmit failed after merge" : "vitest run failed after merge" };
  }
  return { ok: true, mergeSha };
}
