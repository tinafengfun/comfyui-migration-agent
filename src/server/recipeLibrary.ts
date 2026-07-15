/**
 * Recipe library loader (§I).
 *
 * What this is:
 *   recipes/ is the version-controlled, cross-task knowledge base. Each JSON
 *   file is one recipe validated against recipe.schema.json. This module
 *   loads them on demand and offers lookup by nodeType and modelPattern.
 *
 * Who calls this:
 *   - Step 04 source audit: when it sees a CLIPLoader with an fp8 model, it
 *     asks `findRecipesForNode("CLIPLoader", "qwen_2.5_vl_7b_fp8.safetensors")`
 *     and injects matching recipes into the step prompt.
 *   - Step 13 agent-improvement: lists all recipes with low efficacy scores
 *     and asks the human whether to retire or revise them.
 *   - Future recipe-editing UI: lists all, saves back to disk.
 *
 * Why load on every call instead of caching at startup:
 *   recipes/ is small (<100 files expected) and changes are git-versioned.
 *   Loading lazily avoids stale cache bugs when a developer edits a recipe
 *   mid-server-run. If perf becomes an issue, add an mtime-based cache.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { GLOBAL_DIRS } from "./paths";
import { validate, type ValidationResult } from "./schemaValidate";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validated recipe. Matches recipe.schema.json; kept loose (record of string
 * keys to the schema's union types) so callers can read any field without
 * a per-field TS interface. Tighten later if a stable subset emerges.
 */
export interface Recipe {
  recipeId: string;
  version: string;
  nodeType: string;
  modelPattern?: string;
  /** Enum widget values this package injects into the host nodeType's dropdowns. */
  providesEnumValues?: string[];
  /** The host nodeType's enum slots those values belong to (e.g. sampler_name). */
  enumSlots?: string[];
  /** Git repo to clone into custom_nodes/ to install this package. */
  packageRepo?: string;
  xpuSupport: "native" | "patched" | "cpu_offload" | "unsupported" | "unknown";
  patchClass?: "registration_only" | "functional_runtime_support" | "runtime_policy" | "none";
  patchFile?: string;
  patchTarget?: string;
  validationCommand?: string;
  baseVersion?: string;
  knownIssues: string[];
  workarounds?: Array<{
    action: string;
    rationale?: string;
    tradeoff?: string;
  }>;
  validationEvidence?: string;
  validatedOnWorkflows?: string[];
  provenance: {
    taskOrigin: string;
    evidenceArtifact?: string;
    createdAt: string;
    approvedBy?: string;
  };
  retireCondition?: string;
  efficacy?: {
    appliedCount: number;
    successCount: number;
    lastAppliedAt?: string;
  };
}

export interface RecipeLoadResult {
  recipes: Recipe[];
  /** Files that failed schema validation. Loading continues past them. */
  invalid: Array<{ file: string; reason: string }>;
  /** Files that failed JSON.parse. */
  unparseable: Array<{ file: string; reason: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively load every *.json file under recipesRoot (default: the dir
 * pointed at by MIGRATION_RECIPES_DIR). Each file must be a single recipe
 * object (not an array). Files that fail parse or validation are reported
 * in `invalid[]` / `unparseable[]`; healthy recipes still load.
 *
 * If recipesRoot does not exist at all, returns an empty result — this is
 * expected on a fresh checkout before any recipe is authored.
 */
export function loadAllRecipes(recipesRoot: string = GLOBAL_DIRS.recipesRoot): RecipeLoadResult {
  const result: RecipeLoadResult = { recipes: [], invalid: [], unparseable: [] };
  if (!existsSync(recipesRoot)) return result;

  const files = collectRecipeFiles(recipesRoot);
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      result.unparseable.push({ file, reason: `readFile: ${(e as Error).message}` });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      result.unparseable.push({ file, reason: `JSON.parse: ${(e as Error).message}` });
      continue;
    }
    const v: ValidationResult = validate("recipe", parsed);
    if (!v.ok) {
      result.invalid.push({
        file,
        reason: v.errors.map((e) => `${e.path}: ${e.message}`).join("; ")
      });
      continue;
    }
    result.recipes.push(parsed as Recipe);
  }

  result.recipes.sort((a, b) => a.recipeId.localeCompare(b.recipeId));
  return result;
}

/**
 * Recipes whose nodeType matches and (if the recipe declares a modelPattern)
 * whose modelPattern glob matches `modelFilename`. Pass undefined for
 * modelFilename to get all recipes for a nodeType regardless of model.
 *
 * Glob uses the same semantics as POSIX fnmatch: * matches within a path
 * segment, no brace expansion. Sufficient for our patterns like
 * "qwen_*_vl_*_fp8*.safetensors".
 */
export function findRecipesForNode(
  nodeType: string,
  modelFilename?: string,
  recipesRoot?: string
): Recipe[] {
  const { recipes } = loadAllRecipes(recipesRoot);
  return recipes.filter((r) => {
    if (r.nodeType !== nodeType) return false;
    if (!r.modelPattern || !modelFilename) return true;
    return globMatch(r.modelPattern, modelFilename);
  });
}

/** Look up a single recipe by its recipeId. Returns undefined if missing. */
export function findRecipeById(
  recipeId: string,
  recipesRoot?: string
): Recipe | undefined {
  return loadAllRecipes(recipesRoot).recipes.find((r) => r.recipeId === recipeId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function collectRecipeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir, { encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && full.endsWith(".json")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Minimal glob matcher. Translates the pattern to a regex:
 *   * -> [^/]*      (any chars except path separator)
 *   ? -> [^/]       (single char)
 *   . + ( ) etc.    escaped
 * Anchored to the full string.
 */
function globMatch(pattern: string, input: string): boolean {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re).test(input);
}
