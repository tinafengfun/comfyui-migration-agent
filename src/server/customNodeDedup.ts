/**
 * customNodeDedup.ts — root-fix helper for the case-duplicate custom-node dirs
 * that contributed to bug B (V2 Phase 3).
 *
 * The omni bundle ships lowercase-ish dirs (e.g. comfyui-advancedliveportrait)
 * while catalog-driven clones created CamelCase variants (ComfyUI-AdvancedLive-
 * Portrait) under /nfs_share/custom_nodes. On a case-sensitive fs both survive,
 * and a launch that mounts the whole tree double-loads them → duplicate POST
 * routes. Phase 0's buildProfileDir already collapses case-dups at the MOUNT
 * layer (so this is no longer correctness-critical), but this planner cleans the
 * SOURCE tree so the duplication doesn't keep re-propagating.
 *
 * The planner is PURE and conservative: it only proposes removing a duplicate
 * when a clear survivor exists, and it NEVER proposes removing a dir a catalog
 * record points at (`nfsPath`). Deletion is left to the caller (the script
 * defaults to dry-run) — we don't destructively delete shared NFS dirs here.
 */
import path from "node:path";

export interface CustomNodeEntry {
  /** directory name under custom_nodes */
  name: string;
  /** true if this entry is a symlink (vs a real dir) */
  isSymlink?: boolean;
}

export interface DedupAction {
  /** the case-group's lowercased key */
  key: string;
  /** the name kept */
  keep: string;
  /** names proposed for removal */
  remove: string[];
  /** why `keep` won */
  reason: string;
}

export interface DedupPlan {
  actions: DedupAction[];
  /** groups left untouched because no safe survivor could be chosen */
  ambiguous: { key: string; names: string[]; reason: string }[];
}

/**
 * Plan a case-dedup of a custom_nodes listing.
 *
 * @param entries      directory entries under custom_nodes
 * @param catalogPaths absolute nfsPath values referenced by catalog records
 *                     (their basenames are protected — never removed)
 * @param nfsRoot      the custom_nodes dir (to resolve a name → absolute path for
 *                     the catalog-protection check); optional
 */
export function planCaseDedup(
  entries: readonly CustomNodeEntry[],
  catalogPaths: readonly string[] = [],
  nfsRoot = ""
): DedupPlan {
  const protectedNames = new Set(catalogPaths.map((p) => path.basename(p.replace(/\/+$/, ""))));
  const groups = new Map<string, CustomNodeEntry[]>();
  for (const e of entries) {
    const key = e.name.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  const plan: DedupPlan = { actions: [], ambiguous: [] };
  for (const [key, list] of groups) {
    if (list.length < 2) continue; // no dup
    void nfsRoot; // reserved for future absolute-path checks; basename is sufficient today

    // Which of the duplicates are catalog-protected?
    const prot = list.filter((e) => protectedNames.has(e.name));
    if (prot.length > 1) {
      // more than one protected variant → a human must reconcile catalog nfsPaths
      plan.ambiguous.push({ key, names: list.map((e) => e.name), reason: "multiple catalog-referenced variants" });
      continue;
    }

    // Survivor preference: (1) the catalog-protected one, else (2) a real dir over
    // a symlink, else (3) the lexicographically-first lowercase-preferring name.
    let keep: CustomNodeEntry | undefined = prot[0];
    let reason = keep ? "catalog-referenced (nfsPath)" : "";
    if (!keep) {
      const realDirs = list.filter((e) => !e.isSymlink);
      if (realDirs.length === 1) {
        keep = realDirs[0];
        reason = "only real directory (others are symlinks)";
      }
    }
    if (!keep) {
      // prefer the more-lowercase name (fewer uppercase chars), then lexicographic
      const sorted = [...list].sort((a, b) => {
        const ua = (a.name.match(/[A-Z]/g) ?? []).length;
        const ub = (b.name.match(/[A-Z]/g) ?? []).length;
        return ua - ub || a.name.localeCompare(b.name);
      });
      keep = sorted[0];
      reason = "preferred lowercase variant";
    }

    const remove = list.filter((e) => e.name !== keep!.name).map((e) => e.name);
    // Never remove a catalog-protected name even if it wasn't chosen as keep.
    const removeSafe = remove.filter((n) => !protectedNames.has(n));
    if (removeSafe.length !== remove.length) {
      plan.ambiguous.push({ key, names: list.map((e) => e.name), reason: "a non-kept variant is catalog-referenced" });
      continue;
    }
    plan.actions.push({ key, keep: keep.name, remove: removeSafe, reason });
  }
  return plan;
}
