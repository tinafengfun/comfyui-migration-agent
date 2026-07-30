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

describe("mergeImprovement retries a flaky vitest run before reverting", () => {
  // Real incident: pushing 16 approved items in one round ran 16 back-to-back
  // tsc+vitest cycles with no pause between them; all 16 reverted with the
  // identical "vitest run failed after merge" reason, but re-running the
  // exact same merged state in isolation moments later passed cleanly every
  // time -- transient resource contention, not a real defect in any item.
  // These tests fake `npx` on PATH so vitest's own real test run never
  // recurses into itself; the fake counts invocations via a marker file to
  // simulate "fails once under load, succeeds on retry" deterministically.
  async function makeFakeNpx(root: string, failUntilAttempt: number): Promise<{ binDir: string; counterFile: string }> {
    const binDir = path.join(root, "fake-bin");
    const counterFile = path.join(root, "vitest-call-count");
    await ensureDir(binDir);
    await fs.writeFile(
      path.join(binDir, "npx"),
      [
        "#!/bin/bash",
        'if [ "$1" = "tsc" ]; then exit 0; fi',
        'if [ "$1" = "vitest" ] && [ "$2" = "run" ]; then',
        `  counter_file="${counterFile}"`,
        '  count=0',
        '  if [ -f "$counter_file" ]; then count=$(cat "$counter_file"); fi',
        '  count=$((count+1))',
        '  echo "$count" > "$counter_file"',
        `  if [ "$count" -lt "${failUntilAttempt}" ]; then echo "fake vitest failure attempt $count" >&2; exit 1; fi`,
        "  exit 0",
        "fi",
        "exit 0"
      ].join("\n"),
      { mode: 0o755 }
    );
    return { binDir, counterFile };
  }

  it("succeeds when vitest fails once then passes on retry -- merge is accepted, not reverted", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `merge-flaky-retry-${Date.now()}`);
    await initRepo(root);
    await commitFile(root, "a.txt", "a\n", "base");
    await git(root, ["checkout", "-q", "-b", "branch-a"]);
    await commitFile(root, "a.txt", "a changed\n", "branch-a edit");
    await git(root, ["checkout", "-q", "main"]);

    const { binDir, counterFile } = await makeFakeNpx(root, 2); // fails attempt 1, passes attempt 2
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    try {
      const result = await mergeImprovement({ repoRoot: root, item: item("branch-a") });
      expect(result.ok).toBe(true);
      expect(await fs.readFile(counterFile, "utf8")).toContain("2");
      expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("a changed\n");
    } finally {
      process.env.PATH = originalPath;
    }
  }, 20_000);

  it("still reverts (does not retry forever) when vitest fails on every attempt", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `merge-persistent-fail-${Date.now()}`);
    await initRepo(root);
    const preMergeSha = await commitFile(root, "a.txt", "a\n", "base");
    await git(root, ["checkout", "-q", "-b", "branch-a"]);
    await commitFile(root, "a.txt", "a changed\n", "branch-a edit");
    await git(root, ["checkout", "-q", "main"]);

    const { binDir, counterFile } = await makeFakeNpx(root, 999); // never passes
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    try {
      const result = await mergeImprovement({ repoRoot: root, item: item("branch-a") });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("vitest run failed");
      // Exactly 3 attempts (the default maxAttempts), not fewer or more.
      expect(await fs.readFile(counterFile, "utf8")).toContain("3");
      expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(preMergeSha);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 20_000);
});

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
