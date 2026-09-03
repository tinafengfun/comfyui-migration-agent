/**
 * nodeLocalization.ts — the extensible core of the Step-03b "node localization"
 * step. A small registry of NodeHandlers, each of which (a) MATCHES nodes it
 * cares about and (b) PLANS a graph transform for them. The step runs every
 * handler: no matches anywhere → fast-pass (nothing to localize); otherwise it
 * gates on the combined proposals and, on approval, applies the plans.
 *
 * Handler #1 is API-node → local-model substitution (recipe-driven). Future
 * node-processing capabilities plug in by appending a handler here — no change to
 * the step. See docs/prd/api-node-local-substitution.md.
 */
import type { GGraph, SubstitutionPlan } from "./graphSubstitute";
import { loadSubstitutionRecipes, findSubstitutionRecipe, type SubstitutionRecipe } from "./substitutionRecipes";

export interface NodeMatch {
  nodeId: number;
  nodeType: string;
  handlerId: string;
  recipe?: SubstitutionRecipe;
}

export interface NodeHandler {
  id: string;
  /** Nodes in the graph this handler wants to transform. */
  match(graph: GGraph): NodeMatch[];
  /** Substitution plans for the matched nodes. */
  plan(matches: NodeMatch[], graph: GGraph): SubstitutionPlan[];
}

/** Handler #1: replace cloud-API nodes that have a substitution recipe. */
export function makeApiSubstitutionHandler(recipesDir?: string): NodeHandler {
  return {
    id: "api-substitution",
    match(graph) {
      const recipes = loadSubstitutionRecipes(recipesDir);
      const out: NodeMatch[] = [];
      for (const n of graph.nodes ?? []) {
        const type = String(n.type ?? "");
        const recipe = type ? findSubstitutionRecipe(recipes.recipes, type) : undefined;
        if (recipe) out.push({ nodeId: Number(n.id), nodeType: type, handlerId: "api-substitution", recipe });
      }
      return out;
    },
    plan(matches) {
      return matches
        .filter((m) => m.recipe)
        .map((m) => ({ apiNodeId: m.nodeId, recipe: m.recipe! }));
    }
  };
}

/** The active handler registry (append future handlers here). */
export const handlers: NodeHandler[] = [makeApiSubstitutionHandler()];

export interface LocalizationProposal {
  handlerId: string;
  nodeId: number;
  from: string;
  toNodes: string[];
  model?: string;
  droppedInputs: string[];
}
export interface LocalizationPlan {
  plans: SubstitutionPlan[];
  proposals: LocalizationProposal[];
}

/**
 * Run every handler over the graph and collect the combined plan + a
 * human-readable proposal list (for the gate + provenance). Empty proposals ⇒
 * the step fast-passes.
 */
export function planNodeLocalization(graph: GGraph, hs: NodeHandler[] = handlers): LocalizationPlan {
  const plans: SubstitutionPlan[] = [];
  const proposals: LocalizationProposal[] = [];
  for (const h of hs) {
    const matches = h.match(graph);
    if (!matches.length) continue;
    for (const p of h.plan(matches, graph)) {
      plans.push(p);
      proposals.push({
        handlerId: h.id,
        nodeId: p.apiNodeId,
        from: p.recipe.fromNodeType,
        toNodes: p.recipe.toSubgraph.map((s) => s.localType),
        model: p.recipe.model,
        droppedInputs: p.recipe.links.dropInputs ?? []
      });
    }
  }
  return { plans, proposals };
}
