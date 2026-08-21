/**
 * Option B: harvest per-node XPU validation from Step 07's output-branch smoke,
 * instead of running each node in isolation (which hits ComfyUI's prompt_no_outputs
 * for intermediate nodes). Step 07 already runs every output branch; a custom node
 * is confirmed "migrated + works on XPU" — the strict DB-entry gate — ONLY if it was
 * EXECUTED FRESH (in a branch's executed_nodes, not merely cached) on a branch whose
 * run SUCCEEDED. Cached / skipped / not-on-any-successful-branch → never recorded.
 *
 * Pure functions (unit-tested); the orchestrator supplies the Step 07 summary + the
 * id→class_type graph.
 */

/** A successful branch = it passed (with or without cache assistance). */
export const BRANCH_SUCCESS_STATUSES = new Set(["passed", "cache_assisted_pass"]);

export interface BranchSummary {
  status?: string;
  history_summary?: { executed_nodes?: string[]; cached_nodes?: string[] } | null;
}
export interface Step07Summary {
  branch_summaries?: BranchSummary[];
}
/** Minimal API-prompt graph: node id → { class_type }. */
export type PromptGraph = Record<string, { class_type?: string } | undefined>;

/** Node IDs that executed FRESH on a SUCCESSFUL branch. */
export function freshValidatedNodeIds(summary: Step07Summary): Set<string> {
  const fresh = new Set<string>();
  for (const b of summary?.branch_summaries ?? []) {
    if (!b.status || !BRANCH_SUCCESS_STATUSES.has(b.status)) continue;
    for (const nid of b.history_summary?.executed_nodes ?? []) fresh.add(String(nid));
  }
  return fresh;
}

/**
 * class_types that executed fresh on a successful branch (maps the fresh node IDs
 * through the graph). These are the ONLY node types eligible for catalog write-back.
 */
export function freshValidatedNodeTypes(summary: Step07Summary, graph: PromptGraph): Set<string> {
  const ids = freshValidatedNodeIds(summary);
  const types = new Set<string>();
  for (const id of ids) {
    const ct = graph[id]?.class_type;
    if (ct) types.add(ct);
  }
  return types;
}
