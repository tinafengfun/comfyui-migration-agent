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

/**
 * 07-main-smoke-evidence.json: a single whole-graph smoke (single-output workflow).
 * The file is AGENT-WRITTEN and its shape varies run to run (`output_files` may be a
 * list, null, or absent; `executed_nodes` may be an object or a free-text string), so
 * the only stable pass signal is the agent's `classification` verdict — with a
 * produced-output fallback.
 */
export interface MainSmokeEvidence {
  /** Agent verdict for the whole-graph smoke, e.g. "pass". */
  classification?: string;
  /** Output artifacts produced by the run (when the agent populated it). */
  output_files?: Array<{ node_id?: string | number }> | null;
}

const MAIN_SMOKE_PASS = new Set(["pass", "passed", "cache_assisted_pass"]);

/**
 * A workflow with a SINGLE output node makes Step 07 run one whole-graph "main
 * smoke" (07-main-smoke-evidence.json) instead of per-branch smokes — so there is no
 * 07-branch-smoke-summary.json to harvest. A main smoke runs the ENTIRE graph, so on a
 * pass every node in the graph executed successfully → every class_type is validated.
 * Pass is read from the agent's `classification` (stable) or a non-empty `output_files`
 * (fallback). Keeps the "truly tested fresh on XPU this task" guarantee (fresh per-task
 * container) identical to the multi-branch path; a non-pass records nothing.
 */
export function mainSmokeValidatedNodeTypes(evidence: MainSmokeEvidence, graph: PromptGraph): Set<string> {
  const cls = typeof evidence?.classification === "string" ? evidence.classification.toLowerCase() : "";
  const producedOutput = Array.isArray(evidence?.output_files) && evidence.output_files.length > 0;
  if (!MAIN_SMOKE_PASS.has(cls) && !producedOutput) return new Set(); // did not pass ⟹ record nothing
  const types = new Set<string>();
  for (const node of Object.values(graph)) {
    if (node?.class_type) types.add(node.class_type);
  }
  return types;
}
