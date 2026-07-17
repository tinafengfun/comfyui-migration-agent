/**
 * apply-agent-improvements.mts — apply a Step 13-approved agent improvement
 * inside an isolated git worktree, never on the main working tree.
 *
 * Step 13 (self-evolution) already produces `13-agent-improvement.json` with
 * a structured list of proposed changes to the agent's own prompts/skills/
 * scripts. A human approves specific items at the new Step 13 gate (see
 * orchestrator.ts's pauseIfAgentImprovementApprovalNeeded), which flips their
 * `apply_status` to `approved_to_apply`. This tool is the only thing that
 * turns an approved proposal into an actual file change -- and it never
 * commits, pushes, or merges. It creates a throwaway git worktree/branch,
 * runs a scoped Copilot SDK session there to make the edit, prints a diff,
 * and stops. A human reviews the diff and merges manually. This mirrors this
 * project's hard rule that nothing touching the agent's own control surface
 * (prompts/skills/scripts/agent.md) is ever self-approved or self-merged by
 * the agent -- the same discipline already required for Step 12 GUI
 * acceptance.
 *
 * copilotSdkRunner.ts has no enforced filesystem sandbox beyond the
 * session's cwd -- the git-worktree isolation here, not the prompt
 * instruction, is what actually makes this safe: a mistake is confined to a
 * disposable branch instead of landing on main.
 *
 * Usage:
 *   npx tsx scripts/apply-agent-improvements.mts --task <taskId> [--item <id>] [--api http://127.0.0.1:3001]
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../src/server/config";
import { CopilotSdkRunner } from "../src/server/copilotSdkRunner";
import {
  applyItemStatusUpdates,
  readAgentImprovementFile,
  writeAgentImprovementFile,
  type AgentImprovementItem
} from "../src/server/agentImprovementPatch";

const execFileAsync = promisify(execFile);

const API = argValue("--api") ?? process.env.PW_API ?? "http://127.0.0.1:3001";
const taskId = argValue("--task");
const onlyItemId = argValue("--item");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

function buildPrompt(item: AgentImprovementItem): string {
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
    `**Required validation (a human will check these before merging -- run any that are commands you can execute; leave the rest as notes for the reviewer):**`,
    validation,
    "",
    "## Non-negotiable constraints",
    "- Only modify the files listed in \"Target files\" above. If the change genuinely requires touching an unlisted file, stop and explain why instead of proceeding.",
    "- Do NOT run `git commit`, `git push`, `git merge`, or any command that changes git history or branches. You are in a disposable worktree; a human reviews and merges separately.",
    "- Do NOT touch task-state.json, any workspaces/ directory, or any other task's artifacts.",
    "- Keep the change minimal and scoped to exactly this improvement -- do not refactor unrelated content.",
    "- When done, summarize exactly what you changed and why in your final response."
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

  const candidates = state.improvements.filter(
    (item) => item.apply_status === "approved_to_apply" && (!onlyItemId || item.id === onlyItemId)
  );
  if (candidates.length === 0) {
    console.log(
      onlyItemId
        ? `Item ${onlyItemId} isn't approved_to_apply (or doesn't exist). Nothing to do.`
        : "No items are approved_to_apply. Nothing to do."
    );
    return;
  }

  const config = loadConfig();
  const runner = new CopilotSdkRunner(config);
  const repoRoot = config.projectRoot;

  for (const item of candidates) {
    console.log(`\n=== Applying ${item.id} ===`);
    const branchName = `apply-improvement/${item.id}-${Date.now()}`;
    const worktreePath = path.join(repoRoot, ".worktrees", `${item.id}-${Date.now()}`);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });

    await git(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
    console.log(`  worktree created: ${worktreePath} (branch ${branchName})`);

    try {
      const prompt = buildPrompt(item);
      const result = await runner.runFreeformSession({
        cwd: worktreePath,
        prompt,
        sessionId: `apply-${item.id}-${Date.now()}`,
        onProgress: (message) => console.log(`  [sdk] ${message}`)
      });
      console.log(`  SDK session summary:\n${(result.summary ?? "(no summary)").split("\n").map((l) => `    ${l}`).join("\n")}`);

      const status = await git(worktreePath, ["status", "--porcelain"]);
      if (!status.trim()) {
        console.log("  WARNING: no changes were made in the worktree.");
      } else {
        // Stage (not commit) so `git diff --stat` also covers new/untracked
        // files, which plain `git diff` omits entirely.
        await git(worktreePath, ["add", "-A"]);
        const diffStat = await git(worktreePath, ["diff", "--cached", "--stat"]);
        console.log(`  diff --stat (staged, not committed):\n${diffStat.split("\n").map((l) => `    ${l}`).join("\n")}`);
      }
      console.log(`  Review manually: cd ${worktreePath} && git diff --cached`);
      console.log("  Nothing has been committed, pushed, or merged (changes are only staged). Merge manually after review.");

      const current = (await readAgentImprovementFile(filePath))!;
      const { state: updated, unmatchedIds } = applyItemStatusUpdates(current, {
        [item.id]: "awaiting_merge_review"
      });
      if (unmatchedIds.length > 0) {
        console.error(`  WARNING: could not record status update, unmatched id(s): ${unmatchedIds.join(", ")}`);
      } else {
        await writeAgentImprovementFile(filePath, updated);
        console.log(`  ${item.id} marked awaiting_merge_review in ${filePath}.`);
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
