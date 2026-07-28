import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentImprovementItem } from "./agentImprovementPatch";
import { ensureDir } from "./fsUtils";
import { git, mergeImprovement } from "./agentImprovementPipeline";

async function initRepo(root: string): Promise<void> {
  await ensureDir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
}

async function commitFile(root: string, relPath: string, content: string, message: string): Promise<string> {
  await fs.writeFile(path.join(root, relPath), content, "utf8");
  await git(root, ["add", relPath]);
  await git(root, ["commit", "-q", "-m", message]);
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

function item(branch: string): AgentImprovementItem & { draft: NonNullable<AgentImprovementItem["draft"]> } {
  return {
    id: "IMPROV-TEST",
    apply_status: "verified",
    draft: { branch, worktreePath: "", commitSha: "" }
  };
}

describe("mergeImprovement", () => {
  it("cleanly reverts (never throws) on a real git merge conflict, leaving the repo back at pre-merge HEAD (real incident: IMPROV-01/IMPROV-02 independently patched the same lines of step06_prompt_validation.py -- git merge exits non-zero on the conflict, which previously propagated uncaught past the tsc/vitest revert path and left the repo mid-merge)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `merge-conflict-${Date.now()}`);
    await initRepo(root);
    await commitFile(root, "shared.txt", "line one\nline two\nline three\n", "base");

    await git(root, ["checkout", "-q", "-b", "branch-a"]);
    await commitFile(root, "shared.txt", "line one\nCHANGED BY A\nline three\n", "branch-a edit");
    await git(root, ["checkout", "-q", "main"]);

    await git(root, ["checkout", "-q", "-b", "branch-b"]);
    await commitFile(root, "shared.txt", "line one\nCHANGED BY B\nline three\n", "branch-b edit");
    await git(root, ["checkout", "-q", "main"]);

    // Merge branch-a directly (not through mergeImprovement) so this test never
    // invokes the real tsc/vitest gate against a bare, non-TS temp repo -- only
    // the git-merge-conflict path under test (branch-b onto a main that now
    // conflicts with it) goes through mergeImprovement.
    await git(root, ["merge", "--no-ff", "branch-a", "-m", "merge branch-a"]);
    const preMergeSha = (await git(root, ["rev-parse", "HEAD"])).trim();

    const result = await mergeImprovement({ repoRoot: root, item: item("branch-b") });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("conflict");

    const status = await git(root, ["status", "--porcelain"]);
    expect(status.trim()).toBe("");
    const mergeHeadExists = await fs
      .stat(path.join(root, ".git", "MERGE_HEAD"))
      .then(() => true)
      .catch(() => false);
    expect(mergeHeadExists).toBe(false);
    expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(preMergeSha);
    expect(await fs.readFile(path.join(root, "shared.txt"), "utf8")).toBe("line one\nCHANGED BY A\nline three\n");
  });
});
