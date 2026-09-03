/**
 * substitutionRecipes.ts — the capability matrix for Step-03b node localization.
 *
 * One JSON file per cloud-API node class under recipes/substitutions/, each
 * describing how to replace that node with a LOCAL-model subgraph (validated
 * against schemas/node-substitution.schema.json). This is the deterministic,
 * data-driven source of truth the api-substitution handler consults — adding a
 * new mapping is a new file, no code change. See docs/prd/api-node-local-substitution.md.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { GLOBAL_DIRS } from "./paths";
import { validate } from "./schemaValidate";

export interface SubgraphPort {
  name: string;
  type: string;
}
export interface SubgraphNode {
  key: string;
  localType: string;
  inputs?: SubgraphPort[];
  outputs?: SubgraphPort[];
  widgets_values?: unknown[];
}
export interface SubstitutionLinks {
  internal: Array<{ from: { node: string; output: string | number; type?: string }; to: { node: string; input: string } }>;
  inMap: Record<string, { node: string; input: string; asInput?: boolean }>;
  outMap: Record<string, { node: string; output: string | number }>;
  widgetMap?: Record<string, { node: string; widget: string }>;
  dropInputs?: string[];
  audio?: { asrType: string; joinInto: { node: string; input: string } };
}
export interface SubstitutionRecipe {
  id: string;
  fromNodeType: string;
  model?: string;
  description?: string;
  toSubgraph: SubgraphNode[];
  links: SubstitutionLinks;
  provenance: { createdAt: string; approvedBy?: string; note?: string };
}

export interface SubstitutionLoadResult {
  recipes: SubstitutionRecipe[];
  invalid: Array<{ file: string; reason: string }>;
  unparseable: Array<{ file: string; reason: string }>;
}

/** Default location: <recipesRoot>/substitutions/. */
export function substitutionsDir(recipesRoot: string = GLOBAL_DIRS.recipesRoot): string {
  return path.join(recipesRoot, "substitutions");
}

/** Load + validate every substitution recipe. Fresh on each call (mirrors recipeLibrary). */
export function loadSubstitutionRecipes(dir: string = substitutionsDir()): SubstitutionLoadResult {
  const result: SubstitutionLoadResult = { recipes: [], invalid: [], unparseable: [] };
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      result.unparseable.push({ file, reason: (e as Error).message });
      continue;
    }
    const v = validate("nodeSubstitution", parsed);
    if (!v.ok) {
      result.invalid.push({ file, reason: v.errors.map((e) => `${e.path}: ${e.message}`).join("; ") });
      continue;
    }
    result.recipes.push(parsed as SubstitutionRecipe);
  }
  result.recipes.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

/** The substitution recipe for a given API node type, if one exists. */
export function findSubstitutionRecipe(recipes: SubstitutionRecipe[], nodeType: string): SubstitutionRecipe | undefined {
  return recipes.find((r) => r.fromNodeType === nodeType);
}
