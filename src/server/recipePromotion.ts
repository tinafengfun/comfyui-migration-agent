/**
 * Promotes a human-approved core-node recipe draft (see
 * coreNodeRecipeDiscovery.ts) from task-local staging into the real,
 * version-controlled recipes/ and patches/ trees.
 *
 * This is the ONLY path into recipes/nodes/ for a drafted recipe -- drafting
 * itself never writes there. Once promoted, Steps 02/04/05's existing
 * automatic recipe injection (recipeInjector.ts) and Step 05's existing
 * patch-adaptation-protocol pick the new recipe up with zero further code
 * changes, exactly like any hand-authored recipe.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { validateRecipe } from "./schemaValidate";
import { GLOBAL_DIRS } from "./paths";
import type { Recipe } from "./recipeLibrary";

export interface PromoteRecipeDraftInput {
  /** The draft recipe object as staged in 01-acquisition-job.json's coreNodeRecipeDraft.recipe. */
  recipe: Recipe;
  /** Absolute path to the staged patch file (workspacePath + recipe.patchFile). */
  stagedPatchPath: string;
  /** Who approved this promotion -- filled into provenance.approvedBy. */
  approvedBy: string;
  recipesRoot?: string;
  patchesRoot?: string;
}

export interface PromoteRecipeDraftResult {
  recipePath: string;
  patchPath: string;
}

/**
 * Real-fs-only failure modes (staged patch missing, recipe fails re-validation)
 * throw -- promotion is a rare, explicit, human-triggered action, and a
 * silent no-op here would be far more confusing than a clear error.
 */
export async function promoteCoreNodeRecipeDraft(input: PromoteRecipeDraftInput): Promise<PromoteRecipeDraftResult> {
  const recipesRoot = input.recipesRoot ?? GLOBAL_DIRS.recipesRoot;
  const patchesRoot = input.patchesRoot ?? GLOBAL_DIRS.patchesRoot;

  const patchContent = await fs.readFile(input.stagedPatchPath, "utf8");

  const patchFileName = `${input.recipe.nodeType}-core-support.patch`;
  const finalPatchFile = path.join("patches", patchFileName);
  const promoted: Recipe = {
    ...input.recipe,
    patchFile: finalPatchFile,
    provenance: {
      ...input.recipe.provenance,
      approvedBy: input.approvedBy
    }
  };

  const validation = validateRecipe(promoted);
  if (!validation.ok) {
    throw new Error(`recipePromotion: drafted recipe failed re-validation: ${validation.message}`);
  }

  const recipePath = path.join(recipesRoot, "nodes", `${promoted.recipeId}.json`);
  const patchPath = path.join(patchesRoot, patchFileName);

  await fs.mkdir(path.dirname(recipePath), { recursive: true });
  await fs.mkdir(path.dirname(patchPath), { recursive: true });
  await fs.writeFile(patchPath, patchContent, "utf8");
  await fs.writeFile(recipePath, JSON.stringify(promoted, null, 2) + "\n", "utf8");

  return { recipePath, patchPath };
}
