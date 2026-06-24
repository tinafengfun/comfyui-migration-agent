/**
 * Recipe injector (§L).
 *
 * Implements the "hard injection" layer of the two-layer knowledge design
 * (see feedback memory: two_layer_injection.md).
 *
 * What this does:
 *   1. Parse the source workflow JSON to extract (nodeType, modelFilename) pairs.
 *   2. For each pair, call recipeLibrary.findRecipesForNode to get matching recipes.
 *   3. Dedupe by recipeId, sort by id for stable diffs.
 *   4. Format as a markdown prompt section the agent sees during Step 02/04/05.
 *
 * Scope of injection:
 *   Steps 02 (feasibility), 04 (source audit), 05 (environment deploy) —
 *   these are the steps where XPU-specific node/model decisions matter.
 *   Other steps don't see recipes (saves tokens, avoids noise).
 *
 * Failure mode:
 *   Everything is best-effort. If the workflow JSON is malformed, the recipe
 *   dir is missing, or anything throws, return empty string — never break
 *   the step. Soft layer (skills) will still be there.
 */
import { readFile } from "node:fs/promises";
import { findRecipesForNode, type Recipe } from "./recipeLibrary";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Steps where injected recipes actually matter. Other steps get nothing. */
export const RECIPE_INJECTION_STEPS = new Set(["02", "04", "05"]);

export interface NodeModelPair {
  nodeType: string;
  modelFilename?: string;
}

/**
 * Extract (nodeType, modelFilename) pairs from a ComfyUI workflow JSON.
 * Pure function — takes the parsed JSON, returns pairs.
 *
 * Exported for testing; production callers usually use `injectRecipesForWorkflow`.
 */
export function extractNodeModelPairs(workflow: unknown): NodeModelPair[] {
  const graph = workflow as { nodes?: Array<{ type?: string; widgets_values?: unknown[] }> };
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const modelExt = /\.(safetensors|ckpt|pt|pth|onnx|gguf|bin)$/i;
  const pairs: NodeModelPair[] = [];

  for (const node of nodes) {
    const nodeType = typeof node?.type === "string" ? node.type : undefined;
    if (!nodeType) continue;

    const modelValues: string[] = [];
    for (const v of node.widgets_values ?? []) {
      if (typeof v === "string" && modelExt.test(v)) {
        modelValues.push(v);
      }
    }

    if (modelValues.length === 0) {
      pairs.push({ nodeType });
    } else {
      for (const m of modelValues) pairs.push({ nodeType, modelFilename: m });
    }
  }

  return pairs;
}

/**
 * Find all recipes that apply to the given workflow.
 * Pairs are scanned, recipes matched, deduped by recipeId, sorted.
 */
export function findMatchingRecipes(
  pairs: NodeModelPair[],
  recipesRoot?: string
): Recipe[] {
  const byId = new Map<string, Recipe>();
  for (const pair of pairs) {
    const matches = findRecipesForNode(pair.nodeType, pair.modelFilename, recipesRoot);
    for (const r of matches) {
      if (!byId.has(r.recipeId)) byId.set(r.recipeId, r);
    }
  }
  return [...byId.values()].sort((a, b) => a.recipeId.localeCompare(b.recipeId));
}

/**
 * Format a list of recipes as a markdown section for prompt injection.
 * Compact: one block per recipe with id, support status, key workaround.
 */
export function formatRecipesForPrompt(recipes: Recipe[]): string {
  if (recipes.length === 0) return "";
  const blocks = recipes.map((r) => {
    const lines: string[] = [
      `### ${r.recipeId}`,
      `- nodeType: \`${r.nodeType}\``
    ];
    if (r.modelPattern) lines.push(`- modelPattern: \`${r.modelPattern}\``);
    lines.push(`- xpuSupport: \`${r.xpuSupport}\``);
    if (r.patchClass) lines.push(`- patchClass: \`${r.patchClass}\``);
    if (r.patchFile) lines.push(`- patchFile: \`${r.patchFile}\``);
    if (r.knownIssues.length > 0) {
      lines.push(`- knownIssues:`);
      for (const k of r.knownIssues) lines.push(`  - ${k}`);
    }
    if (r.workarounds && r.workarounds.length > 0) {
      lines.push(`- workarounds (in priority order):`);
      r.workarounds.forEach((w, i) => {
        lines.push(`  ${i + 1}. ${w.action}`);
        if (w.tradeoff) lines.push(`     - tradeoff: ${w.tradeoff}`);
      });
    }
    if (r.retireCondition) lines.push(`- retireCondition: ${r.retireCondition}`);
    return lines.join("\n");
  });
  return ["## Matched recipes (from recipe library)", ...blocks].join("\n\n");
}

/**
 * Top-level: read workflow, find recipes, format for prompt.
 * Returns "" (empty) when:
 *   - workflowPath can't be read
 *   - workflow JSON is malformed
 *   - no recipes match
 *   - any error occurs (best-effort, never throws)
 *
 * `stepId` controls whether injection happens at all — only steps in
 * RECIPE_INJECTION_STEPS get recipes. This keeps prompts lean for steps
 * that don't need this signal.
 */
export async function injectRecipesForWorkflow(input: {
  workflowPath: string;
  stepId: string;
  recipesRoot?: string;
}): Promise<string> {
  if (!RECIPE_INJECTION_STEPS.has(input.stepId)) return "";
  try {
    const raw = await readFile(input.workflowPath, "utf8");
    const workflow = JSON.parse(raw);
    const pairs = extractNodeModelPairs(workflow);
    const matches = findMatchingRecipes(pairs, input.recipesRoot);
    return formatRecipesForPrompt(matches);
  } catch {
    return "";
  }
}
