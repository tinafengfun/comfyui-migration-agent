/**
 * apply-agent-improvements.mts — apply a Step 13-approved agent improvement
 * inside an isolated git worktree, never on the main working tree.
 *
 * Step 13 (self-evolution) already produces `13-agent-improvement.json` with
 * a structured list of proposed changes to the agent's own prompts/skills/
 * scripts. A human approves specific items at the new Step 13 gate (see
 * orchestrator.ts's pauseIfAgentImprovementApprovalNeeded), which flips their
 * `apply_status` to `approved_to_apply`. This tool turns an approved proposal
 * into an actual, committed file change on a throwaway git branch -- it
 * never touches main, pushes, or merges. It creates a disposable worktree,
 * runs a scoped Copilot SDK session there to make the edit, deterministically
 * commits the result (the commit itself, not the SDK session, does the
 * committing -- see below), and marks the item `drafted`. This mirrors this
 * project's hard rule that nothing touching the agent's own control surface
 * (prompts/skills/scripts/agent.md) is ever self-approved or self-merged by
 * the agent -- the same discipline already required for Step 12 GUI
 * acceptance.
 *
 * This is stage (a) of the generate -> verify -> merge pipeline:
 *   apply-agent-improvements.mts (this file, "drafted")
 *     -> verify-agent-improvement.mts ("verified" / "verification_failed")
 *     -> merge-agent-improvement.mts ("applied", local merge only; push/deploy
 *        stay separate, explicit, human-triggered actions)
 *
 * copilotSdkRunner.ts has no enforced filesystem sandbox beyond the
 * session's cwd -- the git-worktree isolation here, not the prompt
 * instruction, is what actually makes this safe: a mistake is confined to a
 * disposable branch instead of landing on main.
 *
 * --fix mode: re-invoked on an item already at "verification_failed" (real
 * failures found by verify-agent-improvement.mts). Reuses the SAME
 * disposable worktree/branch (never creates a new one) and hands the SDK
 * session the actual failing command + stderr from the last verification
 * run, so the fix is grounded in real evidence instead of guesswork. Adds a
 * new commit on the same branch and resets status to "drafted" for
 * re-verification.
 *
 * Usage:
 *   npx tsx scripts/apply-agent-improvements.mts --task <taskId> [--item <id>] [--api http://127.0.0.1:3001]
 *   npx tsx scripts/apply-agent-improvements.mts --task <taskId> --item <id> --fix [--api http://127.0.0.1:3001]
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../src/server/config";
import { CopilotSdkRunner } from "../src/server/copilotSdkRunner";
import {
  applyItemPatches,
  readAgentImprovementFile,
  writeAgentImprovementFile,
  type AgentImprovementItem
} from "../src/server/agentImprovementPatch";

const execFileAsync = promisify(execFile);

const API = argValue("--api") ?? process.env.PW_API ?? "http://127.0.0.1:3001";
const taskId = argValue("--task");
const onlyItemId = argValue("--item");
const fixMode = process.argv.includes("--fix");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

const VALIDATE_COMMANDS_FILE = ".agent-improvement-validate.json";

function buildPrompt(item: AgentImprovementItem, sourceTaskArtifactPath: string): string {
  const targetFiles = (item.target_files ?? []).join("\n  - ");
  const validation = (item.required_validation ?? []).map((v) => `  - ${v}`).join("\n") || "  (none specified)";
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
    `Write the resolved commands to ${VALIDATE_COMMANDS_FILE} at the root of this worktree, as JSON:`,
    `  {"commands": ["<literal command 1>", "<literal command 2>", ...]}`,
    `Each command must be runnable via "bash -c" from this worktree's root with no further edits. If a`,
    `validation item genuinely isn't a runnable command (e.g. "re-read the skill and verify X"), omit it`,
    `from the JSON and instead note it in your final summary as something a human must check by reading.`,
    `If there is nothing runnable at all, still write ${VALIDATE_COMMANDS_FILE} with an empty commands array.`,
    `If a check needs more than one Python statement or any control flow (for/if/loops), do NOT write a`,
    `"python3 -c ..." one-liner or a heredoc inline in the command string -- both are fragile to get right`,
    `and, worse, a heredoc's embedded newlines break ${VALIDATE_COMMANDS_FILE}'s own JSON encoding (this`,
    `has happened for real). Instead write an actual small helper script file INSIDE this worktree (e.g.`,
    `.agent-improvement-validate-helpers/check_foo.py), commit it alongside your other changes, and make`,
    `the command a single flat line with no embedded newlines: "python3 .agent-improvement-validate-helpers/check_foo.py".`,
    `Confirm ${VALIDATE_COMMANDS_FILE} is valid JSON yourself (e.g. "python3 -m json.tool ${VALIDATE_COMMANDS_FILE}") before finishing.`,
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
    `**Target files (only touch these, plus ${VALIDATE_COMMANDS_FILE} if the fix is there instead):**`,
    `  - ${targetFiles || "(none listed)"}`,
    "",
    `## What actually failed when this was verified for real`,
    "",
    failureBlock,
    "",
    `Fix the root cause of each failure above. If the bug is in the target file(s) themselves, fix the`,
    `target file. If the bug is only in ${VALIDATE_COMMANDS_FILE}'s own auxiliary validation command (not`,
    `the actual improvement), fix that file instead -- don't touch the target files for a bug that's only`,
    `in your own throwaway validation script. The source task's real artifacts are (read-only) at:`,
    `${sourceTaskArtifactPath}`,
    "",
    `If the fix involves a multi-line/multi-statement check, write it as an actual helper script file in`,
    `this worktree (e.g. .agent-improvement-validate-helpers/check_foo.py) and reference it with a single`,
    `flat command -- do NOT embed a heredoc or multi-line script inline in ${VALIDATE_COMMANDS_FILE}'s`,
    `command string; its embedded newlines will corrupt that file's own JSON encoding (this has happened`,
    `for real). Confirm ${VALIDATE_COMMANDS_FILE} is valid JSON yourself before finishing, e.g.:`,
    `  python3 -m json.tool ${VALIDATE_COMMANDS_FILE}`,
    "",
    "## Non-negotiable constraints",
    "- Only modify the files listed in \"Target files\" above and/or " + VALIDATE_COMMANDS_FILE + ".",
    "- Do NOT run `git commit`, `git push`, `git merge`, or any command that changes git history or branches.",
    "- Do NOT touch task-state.json, any workspaces/ directory, or any other task's artifacts.",
    "- After fixing, re-run the validation command(s) yourself to confirm the fix actually works before finishing.",
    "- When done, summarize exactly what was wrong and what you changed to fix it."
  ].join("\n");
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

    let branchName: string;
    let worktreePath: string;
    if (fixMode) {
      if (!item.draft) {
        console.error(`  ${item.id} has no draft info -- can't fix in-place, run without --fix first.`);
        continue;
      }
      ({ branch: branchName, worktreePath } = item.draft);
      console.log(`  reusing existing worktree: ${worktreePath} (branch ${branchName})`);
    } else {
      branchName = `apply-improvement/${item.id}-${Date.now()}`;
      worktreePath = path.join(repoRoot, ".worktrees", `${item.id}-${Date.now()}`);
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      await git(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
      console.log(`  worktree created: ${worktreePath} (branch ${branchName})`);
    }

    try {
      const prompt = fixMode ? buildFixPrompt(item, task.artifactPath) : buildPrompt(item, task.artifactPath);
      const result = await runner.runFreeformSession({
        cwd: worktreePath,
        prompt,
        sessionId: `${fixMode ? "fix" : "apply"}-${item.id}-${Date.now()}`,
        onProgress: (message) => console.log(`  [sdk] ${message}`)
      });
      console.log(`  SDK session summary:\n${(result.summary ?? "(no summary)").split("\n").map((l) => `    ${l}`).join("\n")}`);

      const status = await git(worktreePath, ["status", "--porcelain"]);
      let commitSha: string | undefined = item.draft?.commitSha;
      const madeChanges = Boolean(status.trim());
      if (!madeChanges) {
        console.log(fixMode ? "  WARNING: fix session made no changes -- the failure is still unresolved." : "  WARNING: no changes were made in the worktree.");
      } else {
        await git(worktreePath, ["add", "-A"]);
        const diffStat = await git(worktreePath, ["diff", "--cached", "--stat"]);
        console.log(`  diff --stat (staged):\n${diffStat.split("\n").map((l) => `    ${l}`).join("\n")}`);
        // Commit deterministically here (not left to the SDK session -- the
        // prompt explicitly forbids it from running git commit) so the
        // review/verify stages have a real commit object to point at
        // (`git show`/`git log -p`) instead of "staged, uncommitted" state.
        // This is still confined to the disposable branch -- no different in
        // risk from staging; nothing has touched main or been pushed.
        const commitMessage = fixMode
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
        console.log(`  committed to disposable branch ${branchName} as ${commitSha}`);
      }
      console.log(`  Review: cd ${worktreePath} && git log -p -1`);
      console.log("  Nothing has been pushed or merged to main. Run scripts/verify-agent-improvement.mts next.");

      // In fix mode, a no-op fix session leaves the item at verification_failed
      // (still broken) rather than falsely advancing it to "drafted".
      const nextStatus = madeChanges ? "drafted" : "verification_failed";
      const current = (await readAgentImprovementFile(filePath))!;
      const { state: updated, unmatchedIds } = applyItemPatches(current, {
        [item.id]: {
          apply_status: nextStatus,
          ...(madeChanges && commitSha ? { draft: { branch: branchName, worktreePath, commitSha } } : {})
        }
      });
      if (unmatchedIds.length > 0) {
        console.error(`  WARNING: could not record status update, unmatched id(s): ${unmatchedIds.join(", ")}`);
      } else {
        await writeAgentImprovementFile(filePath, updated);
        console.log(`  ${item.id} marked ${nextStatus} in ${filePath}.`);
      }
    } catch (error) {
      console.error(`  FAILED applying ${item.id}: ${error instanceof Error ? error.message : error}`);
      console.error(`  Worktree left at ${worktreePath} for inspection.`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
