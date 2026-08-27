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
import { readFileSync } from "node:fs";
import path from "node:path";
import { findRecipesForNode, type Recipe } from "./recipeLibrary";
import { GLOBAL_DIRS } from "./paths";
import { catalogEnabled, resolveNodeType } from "./xpuCatalogClient";
import type { XpuNodeRecord } from "../catalog/schema";

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
  const graph = workflow as { nodes?: Array<{ type?: string; widgets_values?: unknown }> };
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const modelExt = /\.(safetensors|ckpt|pt|pth|onnx|gguf|bin)$/i;
  const pairs: NodeModelPair[] = [];

  for (const node of nodes) {
    const nodeType = typeof node?.type === "string" ? node.type : undefined;
    if (!nodeType) continue;

    // widgets_values is usually an array, but some node types (e.g. VHS_VideoCombine)
    // use a dict. Normalize both to a list of candidates.
    const wv = node.widgets_values;
    let candidates: unknown[];
    if (Array.isArray(wv)) {
      candidates = wv;
    } else if (wv && typeof wv === "object") {
      candidates = Object.values(wv);
    } else {
      candidates = [];
    }

    const modelValues: string[] = [];
    for (const v of candidates) {
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
export function formatRecipesForPrompt(recipes: Recipe[], title = "## Matched recipes (from recipe library)"): string {
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
  return [title, ...blocks].join("\n\n");
}

/**
 * Build the patch adaptation protocol section for recipes that carry a patchFile.
 *
 * Data-driven: called by `injectRecipesForWorkflow` when one or more matched
 * recipes declare `patchFile`. Reads the protocol doc from
 * GLOBAL_DIRS.protocolsRoot (best-effort — returns "" if the file is missing,
 * so recipe data still flows through without the protocol).
 *
 * The protocol doc is the single context file that defines the 3-layer
 * adaptation pipeline (text → structural → semantic). The recipe-specific
 * table appended below gives the agent the concrete targets.
 */
function formatPatchProtocol(patchRecipes: Recipe[]): string {
  const protocolPath = path.join(
    GLOBAL_DIRS.protocolsRoot,
    "patch-adaptation-protocol.md"
  );
  let protocolBody: string;
  try {
    protocolBody = readFileSync(protocolPath, "utf8");
  } catch {
    return "";
  }

  const rows = patchRecipes
    .map((r) => {
      const target = r.patchTarget ?? "_(not specified)_";
      const base = r.baseVersion ?? "_(not specified)_";
      const validate = r.validationCommand ?? "_(not specified)_";
      return `| ${r.recipeId} | \`${r.patchFile}\` | ${target} | ${base} | \`${validate}\` |`;
    })
    .join("\n");

  return [
    protocolBody,
    "",
    "## Recipes requiring patch adaptation",
    "",
    "| recipeId | patchFile | patchTarget | baseVersion | validationCommand |",
    "|---|---|---|---|---|",
    rows
  ].join("\n");
}

/** Convert a TRUSTED catalog record into a recipe-shaped block for prompt injection. */
function catalogRecordToRecipe(rec: XpuNodeRecord, nodeType: string): Recipe {
  return {
    recipeId: `catalog-${rec.nodeKey.replace(/[^A-Za-z0-9_-]/g, "-")}`,
    version: "1.0.0",
    nodeType,
    xpuSupport: rec.xpuSupport,
    patchClass: rec.patchClass,
    patchFile: rec.patches?.[0]?.file,
    patchTarget: rec.patches?.[0]?.target,
    baseVersion: rec.patches?.[0]?.baseVersion,
    knownIssues: rec.knownIssues ?? [],
    workarounds: rec.workarounds,
    retireCondition: rec.retireCondition,
    providesEnumValues: rec.providesEnumValues,
    enumSlots: rec.enumSlots,
    packageRepo: rec.repository || undefined,
    provenance: { taskOrigin: rec.originTaskId ?? "catalog", createdAt: (rec.createdAt || "").slice(0, 10) }
  } as Recipe;
}

interface CatalogHit {
  record: XpuNodeRecord;
  nodeType: string;
}

/**
 * Bridge: pull catalog records for the workflow's nodeTypes (that the recipe
 * library didn't already match) so the DB's accumulated XPU knowledge drives the
 * same steps. Best-effort; empty unless XPU_CATALOG_ENABLED.
 *
 * Returns hits of ALL tiers — the caller renders trusted records as "apply as-is"
 * and candidate/unsupported records as verify-first / boundary HINTS. Non-trusted
 * knowledge (the accumulated knownIssues/workarounds for nodes migrated by hand) is
 * pure loss if dropped; injecting it as prose is safe because the deterministic
 * auto-apply patch table (`formatPatchProtocol`) only ever runs on recipe-library
 * `matches`, never on these catalog hits — so a hint can never become an auto-apply.
 */
async function catalogHitsForPairs(pairs: NodeModelPair[], existing: Recipe[]): Promise<CatalogHit[]> {
  if (!catalogEnabled()) return [];
  const existingTypes = new Set(existing.map((r) => r.nodeType));
  const seenKeys = new Set<string>();
  const out: CatalogHit[] = [];
  for (const nodeType of [...new Set(pairs.map((p) => p.nodeType))]) {
    if (existingTypes.has(nodeType)) continue;
    try {
      const hit = await resolveNodeType(nodeType);
      if (!hit || seenKeys.has(hit.record.nodeKey)) continue;
      seenKeys.add(hit.record.nodeKey);
      out.push({ record: hit.record, nodeType });
    } catch {
      /* best-effort — catalog is advisory here */
    }
  }
  return out.sort((a, b) => a.record.nodeKey.localeCompare(b.record.nodeKey));
}

/**
 * Format candidate/unsupported catalog records as PROSE HINTS for the agent.
 * Deliberately NOT via `catalogRecordToRecipe`: that emits a bare `patchFile:` that
 * reads like "apply me". Here patches are rendered as "reference — re-audit before
 * applying, NOT pre-approved", so non-trusted patch knowledge never looks auto-applyable.
 */
function formatCatalogHints(hits: CatalogHit[], tier: "candidate" | "unsupported"): string {
  if (hits.length === 0) return "";
  const title =
    tier === "candidate"
      ? "## Candidate catalog records — PRIOR EVIDENCE, VERIFY BEFORE APPLYING"
      : "## Known migration boundaries (from catalog) — LIKELY HUMAN / DO NOT AUTO-APPLY";
  const preamble =
    tier === "candidate"
      ? "Not trusted. Treat as hints from prior hand-migrations: re-verify against the current node source and confirm via /object_info registration + a Step-07 smoke pass on XPU before relying on them."
      : "Known NOT to migrate cleanly. Spend NO autonomous attempts here — route per the capability matrix (human / unsupported). `retireCondition` says when to re-evaluate.";
  const blocks = hits.map(({ record: r, nodeType }) => {
    const lines: string[] = [
      `### catalog-${r.nodeKey.replace(/[^A-Za-z0-9_-]/g, "-")}`,
      `- nodeType: \`${nodeType}\``,
      `- xpuSupport: \`${r.xpuSupport}\``,
      `- tier: \`${r.tier}\``
    ];
    if (r.migrationRoute) lines.push(`- migrationRoute: \`${r.migrationRoute}\``);
    if (r.repository) lines.push(`- repository: \`${r.repository}\``);
    if (r.knownIssues && r.knownIssues.length > 0) {
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
    if (r.patches && r.patches.length > 0) {
      lines.push(`- reference patch(es) (re-audit against current source before applying — NOT pre-approved):`);
      for (const p of r.patches) lines.push(`  - ${p.file}${p.target ? ` (target: ${p.target})` : ""}`);
    }
    if (r.retireCondition) lines.push(`- retireCondition: ${r.retireCondition}`);
    return lines.join("\n");
  });
  return [title, preamble, ...blocks].join("\n\n");
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
    let result = formatRecipesForPrompt(matches);

    // Bridge: append catalog records (that the recipe library didn't already cover)
    // as additional sections, partitioned by tier. Off unless XPU_CATALOG_ENABLED.
    //   trusted     → "apply as-is" (recipe-shaped, may carry patchFile)
    //   candidate   → verify-first HINTS (patches shown as reference only)
    //   unsupported → boundary HINTS (do not auto-apply)
    // Only trusted records become recipe-shaped; candidate/unsupported are prose hints,
    // so they can never enter the Step-05 auto-apply table (keyed on `matches` below).
    const catalogHits = await catalogHitsForPairs(pairs, matches);
    const trustedHits = catalogHits.filter((h) => h.record.tier === "trusted");
    if (trustedHits.length > 0) {
      const trustedRecipes = trustedHits
        .map((h) => catalogRecordToRecipe(h.record, h.nodeType))
        .sort((a, b) => a.recipeId.localeCompare(b.recipeId));
      const section = formatRecipesForPrompt(
        trustedRecipes,
        "## Matched catalog records (trusted XPU-support DB) — apply as-is"
      );
      result = result ? `${result}\n\n${section}` : section;
    }
    const candSection = formatCatalogHints(catalogHits.filter((h) => h.record.tier === "candidate"), "candidate");
    if (candSection) result = result ? `${result}\n\n${candSection}` : candSection;
    const unsupSection = formatCatalogHints(catalogHits.filter((h) => h.record.tier === "unsupported"), "unsupported");
    if (unsupSection) result = result ? `${result}\n\n${unsupSection}` : unsupSection;

    // Append patch adaptation protocol when patch-carrying recipes match at step 05.
    // Steps 02/04 still see patchFile in the recipe data block; they don't need
    // the full pipeline doc. Data-driven: any recipe with patchFile triggers this.
    const patchRecipes = matches.filter((r) => r.patchFile);
    if (patchRecipes.length > 0 && input.stepId === "05") {
      const protocolSection = formatPatchProtocol(patchRecipes);
      if (protocolSection) result = result + "\n\n" + protocolSection;
    }

    return result;
  } catch {
    return "";
  }
}

/**
 * Return the recipeIds that would be injected for the given workflow + step.
 * Sync convenience for analytics tracking (§H) — avoids re-reading the file
 * when the caller already has the workflow path. Returns [] on any error.
 */
export function getMatchedRecipeIds(
  workflowPath: string,
  stepId: string,
  recipesRoot?: string
): string[] {
  if (!RECIPE_INJECTION_STEPS.has(stepId)) return [];
  try {
    const raw = readFileSync(workflowPath, "utf8");
    const workflow = JSON.parse(raw);
    const pairs = extractNodeModelPairs(workflow);
    return findMatchingRecipes(pairs, recipesRoot).map((r) => r.recipeId);
  } catch {
    return [];
  }
}
