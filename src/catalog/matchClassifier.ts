/**
 * RESOLVE classification — the deterministic core of "search the catalog first,
 * then decide how to migrate a node" (the agreed per-node state machine).
 *
 * Pure function: given a resolved catalog record (or null) + the current node's
 * context (the commit we'd deploy + the model dtype in use), decide the route:
 *   apply-known    — trusted, commit + dtype match → deploy the known recipe as-is
 *   adapt          — trusted, dtype matches but commit drifted → adapt the recipe
 *                    via the patch-adaptation protocol
 *   apply-candidate— a candidate (unverified) record → use as a hint, still validate
 *   explore        — dtype drift (re-migrate from scratch), unsupported record, or
 *                    no usable record
 *   miss           — nothing in the catalog
 *
 * Decisions locked: dtype drift ALWAYS forces a fresh migration (explore); commit
 * drift on a trusted record adapts the old recipe; a candidate is applied but must
 * still be validated (never trusted blindly).
 */
import type { XpuNodeRecord } from "./schema";

export type MatchClass = "apply-known" | "adapt" | "apply-candidate" | "explore" | "miss";

export interface MigrationContext {
  /** The commit we would deploy this node at (from Step 01 clone / workflow pin). */
  commit?: string;
  /** The model dtype this workflow uses the node with (e.g. "fp8_e4m3fn"). */
  dtype?: string;
}

/** True when `ctx.dtype` is compatible with the record (record lists it, or lists none). */
function dtypeMatches(record: XpuNodeRecord, ctx: MigrationContext): boolean {
  if (!ctx.dtype) return true; // caller didn't determine a dtype → don't force a drift
  const supported = record.supportedDtypes ?? [];
  if (supported.length === 0) return true; // record is dtype-agnostic
  return supported.includes(ctx.dtype);
}

/** True when `ctx.commit` matches the record's pinned commit or its known-good set. */
function commitMatches(record: XpuNodeRecord, ctx: MigrationContext): boolean {
  if (!ctx.commit) return true; // caller didn't determine a commit → treat as match
  if (!record.commit && !(record.versionsSupported ?? []).length) return true; // record didn't pin one
  if (record.commit && record.commit === ctx.commit) return true;
  return (record.versionsSupported ?? []).includes(ctx.commit);
}

/**
 * Classify how to migrate a node given its resolved record + context.
 * `record === null` (a clean catalog miss) → "miss".
 */
export function classifyCatalogMatch(
  record: XpuNodeRecord | null | undefined,
  ctx: MigrationContext = {}
): MatchClass {
  if (!record) return "miss";
  // dtype drift wins over everything: a record proven for a different dtype must
  // not be reused — re-migrate from scratch (locked decision 4b).
  if (!dtypeMatches(record, ctx)) return "explore";
  if (record.tier === "unsupported") return "explore"; // no known path; upstream may have changed
  if (record.tier === "candidate") return "apply-candidate"; // hint, but must validate
  // trusted:
  return commitMatches(record, ctx) ? "apply-known" : "adapt";
}

/** Whether a route means "the record's knowledge is being created or updated" (→ needs precise write-back). */
export function routeCreatesOrUpdatesRecord(route: MatchClass): boolean {
  return route === "explore" || route === "miss" || route === "adapt" || route === "apply-candidate";
}
