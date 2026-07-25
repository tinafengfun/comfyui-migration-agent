/**
 * Isolated, deterministic verification for a core-node recipe draft (see
 * coreNodeRecipeDiscovery.ts) -- lets a human adopt a draft with real proof
 * attached ("this patch applies cleanly and genuinely registers the node")
 * instead of having to read and judge a raw diff themselves. This module
 * only checks and reports; it never writes into recipes/ or patches/ itself
 * -- promotion still requires one explicit human click via the existing
 * "Adopt this drafted recipe" action (recipePromotion.ts), same as before.
 *
 * Deliberately bounded to STRUCTURAL verification, not functional/GPU
 * verification: confirms the patch applies cleanly and genuinely registers
 * the claimed node type. It does NOT exercise the node's runtime behavior
 * (that would need bespoke, per-node dummy CLIP/VAE/IMAGE input
 * construction -- not safely generalizable).
 *
 * Runs entirely against an isolated `git worktree` scratch copy of
 * comfyuiRoot -- never mutates the live checkout, so a bad draft can't
 * affect anything even mid-verification.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { loadBuiltinNodeTypes, resetBuiltinNodeCache } from "./builtinNodes";

const execFileAsync = promisify(execFile);

export interface VerifyCoreNodeRecipeInput {
  nodeType: string;
  /** Comma-separated repo-relative file paths the patch is expected to touch (Recipe.patchTarget). */
  patchTarget?: string;
  /** Absolute path to the already-staged patch file (workspacePath + recipe.patchFile). */
  stagedPatchPath: string;
  comfyuiRoot: string;
}

export interface VerifyCoreNodeRecipeResult {
  verified: boolean;
  /** Human-readable summary of what was checked and why it did/didn't pass -- shown to the human before they adopt. */
  verificationDetail: string;
  /** Only set when verified -- the literal check that was run, worth recording in the recipe once adopted. */
  validationCommand?: string;
}

export async function verifyCoreNodeRecipe(input: VerifyCoreNodeRecipeInput): Promise<VerifyCoreNodeRecipeResult> {
  const scratchPath = path.join(os.tmpdir(), "core-node-verify", `${input.nodeType}-${crypto.randomUUID()}`);
  let worktreeCreated = false;
  try {
    await fs.mkdir(path.dirname(scratchPath), { recursive: true });
    await execFileAsync("git", ["-C", input.comfyuiRoot, "worktree", "add", "--detach", scratchPath, "HEAD"]);
    worktreeCreated = true;

    const applyResult = await execFileAsync("git", ["-C", scratchPath, "apply", "--3way", input.stagedPatchPath]).catch(
      (error) => ({ failed: true, message: error instanceof Error ? error.message : String(error) })
    );
    if (applyResult && "failed" in applyResult) {
      return {
        verified: false,
        verificationDetail: `Patch did not apply cleanly to an isolated worktree (git apply --3way failed): ${applyResult.message}`
      };
    }

    const filesTouched = (input.patchTarget ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    const pythonFiles = filesTouched.filter((f) => f.endsWith(".py"));
    for (const file of pythonFiles) {
      const compileResult = await execFileAsync("python3", ["-m", "py_compile", path.join(scratchPath, file)]).catch(
        (error) => ({ failed: true, message: error instanceof Error ? error.message : String(error) })
      );
      if (compileResult && "failed" in compileResult) {
        return {
          verified: false,
          verificationDetail: `Patch applied, but ${file} failed to compile as valid Python: ${compileResult.message}`
        };
      }
    }

    // Force a fresh parse of the scratch worktree -- it's a different root
    // than the live checkout, but loadBuiltinNodeTypes' cache is keyed by
    // root path (see builtinNodes.ts), so this is safe without touching the
    // live root's cached result.
    resetBuiltinNodeCache();
    const registeredTypes = loadBuiltinNodeTypes(scratchPath);
    if (!registeredTypes.has(input.nodeType)) {
      return {
        verified: false,
        verificationDetail: `Patch applied and files compiled, but "${input.nodeType}" is still not found registered in comfy_extras/nodes.py after applying -- the patch may not actually add this node.`
      };
    }

    const validationCommand = pythonFiles.length
      ? `python3 -m py_compile ${pythonFiles.join(" ")} && grep -q '"${input.nodeType}"' comfy_extras/*.py nodes.py`
      : undefined;

    return {
      verified: true,
      verificationDetail: `Patch applied cleanly, ${pythonFiles.length} touched file(s) compiled, and "${input.nodeType}" is confirmed registered. Structural verification only -- runtime/XPU behavior is not yet exercised.`,
      validationCommand
    };
  } catch (error) {
    return {
      verified: false,
      verificationDetail: `Verification could not complete: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    if (worktreeCreated) {
      await execFileAsync("git", ["-C", input.comfyuiRoot, "worktree", "remove", "--force", scratchPath]).catch(() => undefined);
    }
  }
}
