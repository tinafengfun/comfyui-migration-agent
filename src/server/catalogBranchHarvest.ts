/**
 * Option B: harvest per-node XPU validation from Step 07's output-branch smoke.
 *
 * IMPORTANT (learned from real archived data): ComfyUI's /history does NOT persist
 * the live "executing"/"node_execution_start" events — those are WebSocket-only — so
 * `history_summary.executed_nodes` is essentially always empty when read back. We
 * therefore CANNOT gate on "executed fresh" from history. Instead we use a reliable
 * graph-based signal: a custom node is validated iff it lies on the dependency
 * subgraph of a branch whose run SUCCEEDED (passed / cache_assisted_pass).
 *
 * Why this still satisfies "truly tested on XPU before DB": Step 05 launches a FRESH
 * per-task ComfyUI container (comfyui-${TASK_ID}), so a node on the path of a
 * successful branch necessarily executed successfully on the XPU during THIS task
 * (its first use in the session runs fresh; there is no stale cross-task cache).
 * Cached/failed/not-on-any-successful-branch → never recorded.
 *
 * Pure functions (unit-tested); the orchestrator supplies the Step 07 summary + the
 * id→node graph (from the Step-06 runtime-policy prompt).
 */

/** A successful branch = it passed (with or without cache assistance). */
export const BRANCH_SUCCESS_STATUSES = new Set(["passed", "cache_assisted_pass"]);

export interface BranchSummary {
  /** Step 07 slug: "node-<output_node_id>". */
  branch?: string;
  status?: string;
}
export interface Step07Summary {
  branch_summaries?: BranchSummary[];
}
/** Minimal API-prompt graph: node id → { class_type, inputs }. */
export type PromptGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown> } | undefined>;

/** Output node id from a Step-07 branch slug "node-<id>". */
function outputIdFromBranch(slug?: string): string | undefined {
  if (!slug) return undefined;
  const m = /^node-(.+)$/.exec(slug);
  return m ? m[1] : undefined;
}

/** Transitive upstream subgraph (target + everything it depends on) as node ids. */
export function subgraphIds(graph: PromptGraph, targetId: string): Set<string> {
  const keep = new Set<string>();
  const stack = [targetId];
  while (stack.length) {
    const nid = stack.pop() as string;
    if (keep.has(nid) || !graph[nid]) continue;
    keep.add(nid);
    for (const value of Object.values(graph[nid]?.inputs ?? {})) {
      // a wired input is [source_node_id, output_index]
      if (Array.isArray(value) && value.length && (typeof value[0] === "string" || typeof value[0] === "number")) {
        const src = String(value[0]);
        if (graph[src] && !keep.has(src)) stack.push(src);
      }
    }
  }
  return keep;
}

/**
 * class_types on the dependency path of any SUCCESSFUL branch — the ONLY node types
 * eligible for catalog write-back (the strict "truly tested on XPU" gate).
 */
export function branchValidatedNodeTypes(summary: Step07Summary, graph: PromptGraph): Set<string> {
  const types = new Set<string>();
  for (const b of summary?.branch_summaries ?? []) {
    if (!b.status || !BRANCH_SUCCESS_STATUSES.has(b.status)) continue;
    const outId = outputIdFromBranch(b.branch);
    if (!outId) continue;
    for (const nid of subgraphIds(graph, outId)) {
      const ct = graph[nid]?.class_type;
      if (ct) types.add(ct);
    }
  }
  return types;
}

/** 07-main-smoke-evidence.json: a single whole-graph smoke (single-output workflow). */
export interface MainSmokeEvidence {
  /** Output artifacts produced by the run; non-empty ⟺ the smoke passed. */
  output_files?: Array<{ node_id?: string | number }>;
}

/**
 * A workflow with a SINGLE output node makes Step 07 run one whole-graph "main
 * smoke" (07-main-smoke-evidence.json) instead of per-branch smokes — so there is no
 * 07-branch-smoke-summary.json to harvest. Treat each produced output file's node as
 * one SUCCESSFUL branch and reuse the exact branch-subgraph gate: a main smoke is
 * "passed" iff it produced at least one output (the same evidence the agent uses),
 * and then every node on that output's dependency subgraph is validated. Keeps the
 * "truly tested fresh on XPU this task" guarantee (fresh per-task container) identical
 * to the multi-branch path.
 */
export function mainSmokeValidatedNodeTypes(evidence: MainSmokeEvidence, graph: PromptGraph): Set<string> {
  const outputs = evidence?.output_files ?? [];
  if (!outputs.length) return new Set(); // no output ⟹ did not pass ⟹ record nothing
  const branch_summaries: BranchSummary[] = [];
  for (const o of outputs) {
    if (o?.node_id != null) branch_summaries.push({ branch: `node-${o.node_id}`, status: "passed" });
  }
  return branchValidatedNodeTypes({ branch_summaries }, graph);
}
