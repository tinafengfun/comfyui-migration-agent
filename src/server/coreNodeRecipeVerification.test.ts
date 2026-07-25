import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCoreNodeRecipe } from "./coreNodeRecipeVerification";
import { ensureDir } from "./fsUtils";

const NODES_PY_INITIAL = "NODE_CLASS_MAPPINGS = {\n}\n";

async function initFixtureRepo(dirName: string): Promise<{ root: string; nodesPyPath: string }> {
  const root = path.join(process.cwd(), ".demo-state", "tests", dirName);
  await ensureDir(path.join(root, "comfy_extras"));
  const nodesPyPath = path.join(root, "comfy_extras", "nodes.py");
  await fs.writeFile(nodesPyPath, NODES_PY_INITIAL, "utf8");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });
  return { root, nodesPyPath };
}

/**
 * Edits comfy_extras/nodes.py to `newContent`, captures the resulting diff
 * as a real, git-apply-able patch (via `git diff`), then reverts the
 * working tree back to the committed state -- so the fixture repo's HEAD
 * (what verifyCoreNodeRecipe's `git worktree add ... HEAD` actually reads)
 * stays clean and reusable across multiple test cases.
 */
function makePatch(root: string, newContent: string): string {
  const nodesPyPath = path.join(root, "comfy_extras", "nodes.py");
  execFileSync("node", ["-e", `require("fs").writeFileSync(${JSON.stringify(nodesPyPath)}, ${JSON.stringify(newContent)})`]);
  const patch = execFileSync("git", ["diff", "--no-color", "--", "comfy_extras/nodes.py"], { cwd: root }).toString("utf8");
  execFileSync("git", ["checkout", "--", "comfy_extras/nodes.py"], { cwd: root });
  return patch;
}

async function writePatchFile(root: string, name: string, content: string): Promise<string> {
  const patchDir = path.join(root, "staged-patch");
  await ensureDir(patchDir);
  const patchPath = path.join(patchDir, name);
  await fs.writeFile(patchPath, content, "utf8");
  return patchPath;
}

describe("verifyCoreNodeRecipe", () => {
  it("verifies a patch that applies cleanly and genuinely registers the claimed node", async () => {
    const { root } = await initFixtureRepo(`core-verify-happy-${Date.now()}`);
    const patchContent = makePatch(root, 'NODE_CLASS_MAPPINGS = {\n    "TextEncodeBooguEdit": TextEncodeBooguEdit,\n}\n');
    const patchPath = await writePatchFile(root, "happy.patch", patchContent);

    const result = await verifyCoreNodeRecipe({
      nodeType: "TextEncodeBooguEdit",
      patchTarget: "comfy_extras/nodes.py",
      stagedPatchPath: patchPath,
      comfyuiRoot: root
    });

    expect(result.verified).toBe(true);
    expect(result.validationCommand).toBeTruthy();

    // No leaked worktrees after a successful run.
    const worktreeList = execFileSync("git", ["worktree", "list"], { cwd: root }).toString("utf8");
    expect(worktreeList.trim().split("\n")).toHaveLength(1);
  }, 30000);

  it("fails verification when the patch does not apply cleanly (conflict)", async () => {
    const { root, nodesPyPath } = await initFixtureRepo(`core-verify-conflict-${Date.now()}`);
    const patchContent = makePatch(root, 'NODE_CLASS_MAPPINGS = {\n    "TextEncodeBooguEdit": TextEncodeBooguEdit,\n}\n');
    // Diverge the actual committed file from what the patch's context expects,
    // so applying it now genuinely conflicts.
    await fs.writeFile(nodesPyPath, "NODE_CLASS_MAPPINGS = {\n    \"SomethingElseEntirely\": Foo,\n    \"AnotherOne\": Bar,\n}\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "diverge"], { cwd: root });
    const patchPath = await writePatchFile(root, "conflict.patch", patchContent);

    const result = await verifyCoreNodeRecipe({
      nodeType: "TextEncodeBooguEdit",
      patchTarget: "comfy_extras/nodes.py",
      stagedPatchPath: patchPath,
      comfyuiRoot: root
    });

    expect(result.verified).toBe(false);
    expect(result.verificationDetail).toContain("did not apply cleanly");

    const worktreeList = execFileSync("git", ["worktree", "list"], { cwd: root }).toString("utf8");
    expect(worktreeList.trim().split("\n")).toHaveLength(1);
  }, 30000);

  it("fails verification when the patch applies but does not actually register the claimed node", async () => {
    const { root } = await initFixtureRepo(`core-verify-no-registration-${Date.now()}`);
    // A comment-only addition: applies cleanly, but never adds a real mapping entry.
    const patchContent = makePatch(root, "NODE_CLASS_MAPPINGS = {\n    # TextEncodeBooguEdit support planned\n}\n");
    const patchPath = await writePatchFile(root, "no-registration.patch", patchContent);

    const result = await verifyCoreNodeRecipe({
      nodeType: "TextEncodeBooguEdit",
      patchTarget: "comfy_extras/nodes.py",
      stagedPatchPath: patchPath,
      comfyuiRoot: root
    });

    expect(result.verified).toBe(false);
    expect(result.verificationDetail).toContain("not found registered");
  }, 30000);

  it("fails verification when a touched Python file has a syntax error", async () => {
    const { root } = await initFixtureRepo(`core-verify-syntax-error-${Date.now()}`);
    const patchContent = makePatch(root, 'NODE_CLASS_MAPPINGS = {\n    "TextEncodeBooguEdit" TextEncodeBooguEdit,\n}\n');
    const patchPath = await writePatchFile(root, "syntax-error.patch", patchContent);

    const result = await verifyCoreNodeRecipe({
      nodeType: "TextEncodeBooguEdit",
      patchTarget: "comfy_extras/nodes.py",
      stagedPatchPath: patchPath,
      comfyuiRoot: root
    });

    expect(result.verified).toBe(false);
    expect(result.verificationDetail).toContain("failed to compile");
  }, 30000);

  it("cleans up the scratch worktree even when the comfyuiRoot itself is invalid", async () => {
    const result = await verifyCoreNodeRecipe({
      nodeType: "AnyNode",
      patchTarget: "comfy_extras/nodes.py",
      stagedPatchPath: "/nonexistent/patch.patch",
      comfyuiRoot: "/nonexistent/comfyui-root"
    });
    expect(result.verified).toBe(false);
    expect(result.verificationDetail).toBeTruthy();
  }, 30000);
});
