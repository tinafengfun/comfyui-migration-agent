import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { promoteCoreNodeRecipeDraft } from "./recipePromotion";
import { ensureDir } from "./fsUtils";
import type { Recipe } from "./recipeLibrary";

function draftRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    recipeId: "TextEncodeBooguEdit-core-support-draft",
    version: "0.1.0",
    nodeType: "TextEncodeBooguEdit",
    xpuSupport: "unknown",
    patchFile: "artifacts/staged-recipes/TextEncodeBooguEdit-core-support.patch",
    patchTarget: "comfy_extras/nodes_boogu.py",
    knownIssues: ["Auto-drafted from upstream discovery; not yet validated on XPU or reviewed by a human."],
    provenance: { taskOrigin: "task-abc", createdAt: "2026-07-24" },
    ...overrides
  };
}

describe("promoteCoreNodeRecipeDraft", () => {
  it("writes the recipe into recipes/nodes/ and the patch into patches/, filling approvedBy", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `recipe-promotion-${Date.now()}`);
    const recipesRoot = path.join(root, "recipes");
    const patchesRoot = path.join(root, "patches");
    const stagedPatchPath = path.join(root, "workspace", "artifacts", "staged-recipes", "TextEncodeBooguEdit-core-support.patch");
    await ensureDir(path.dirname(stagedPatchPath));
    await fs.writeFile(stagedPatchPath, "diff --git a/comfy_extras/nodes_boogu.py b/comfy_extras/nodes_boogu.py\n", "utf8");

    const result = await promoteCoreNodeRecipeDraft({
      recipe: draftRecipe(),
      stagedPatchPath,
      approvedBy: "test-operator",
      recipesRoot,
      patchesRoot
    });

    expect(result.recipePath).toBe(path.join(recipesRoot, "nodes", "TextEncodeBooguEdit-core-support-draft.json"));
    expect(result.patchPath).toBe(path.join(patchesRoot, "TextEncodeBooguEdit-core-support.patch"));

    const written = JSON.parse(await fs.readFile(result.recipePath, "utf8")) as Recipe;
    expect(written.provenance.approvedBy).toBe("test-operator");
    expect(written.patchFile).toBe("patches/TextEncodeBooguEdit-core-support.patch");

    const patchContent = await fs.readFile(result.patchPath, "utf8");
    expect(patchContent).toContain("nodes_boogu.py");
  });

  it("throws (does not silently write) when the promoted recipe fails schema re-validation", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `recipe-promotion-invalid-${Date.now()}`);
    const recipesRoot = path.join(root, "recipes");
    const patchesRoot = path.join(root, "patches");
    const stagedPatchPath = path.join(root, "workspace", "artifacts", "staged-recipes", "Bad Node-core-support.patch");
    await ensureDir(path.dirname(stagedPatchPath));
    await fs.writeFile(stagedPatchPath, "diff --git a/foo b/foo\n", "utf8");

    await expect(
      promoteCoreNodeRecipeDraft({
        // Invalid recipeId (spaces/punctuation outside the schema's allowed pattern).
        recipe: draftRecipe({ recipeId: "Bad Node:Recipe!", nodeType: "Bad Node" }),
        stagedPatchPath,
        approvedBy: "test-operator",
        recipesRoot,
        patchesRoot
      })
    ).rejects.toThrow(/failed re-validation/);

    const recipeFiles = await fs.readdir(path.join(recipesRoot, "nodes")).catch(() => []);
    expect(recipeFiles).toHaveLength(0);
  });

  it("throws when the staged patch file is missing", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `recipe-promotion-missing-patch-${Date.now()}`);
    const recipesRoot = path.join(root, "recipes");
    const patchesRoot = path.join(root, "patches");

    await expect(
      promoteCoreNodeRecipeDraft({
        recipe: draftRecipe(),
        stagedPatchPath: path.join(root, "workspace", "artifacts", "staged-recipes", "does-not-exist.patch"),
        approvedBy: "test-operator",
        recipesRoot,
        patchesRoot
      })
    ).rejects.toThrow();
  });
});
