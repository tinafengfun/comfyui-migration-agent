/**
 * dedup-custom-nodes.mts — report (and optionally remove) case-duplicate dirs
 * under a custom_nodes tree, the root-fix for the bug-B case-dup contributor
 * (V2 Phase 3). Dry-run by default; --apply performs the removals the pure
 * planner proposes (never touching a catalog-referenced variant).
 *
 * Usage:
 *   npx tsx scripts/dedup-custom-nodes.mts [--root /nfs_share/custom_nodes] [--apply]
 *     [--catalog-nfs-paths a,b,c]
 *
 * Catalog-referenced paths (their basenames) are protected. Pass them via
 * --catalog-nfs-paths, or leave empty to dedup purely by lowercase preference.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { planCaseDedup, type CustomNodeEntry } from "../src/server/customNodeDedup";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

async function main(): Promise<void> {
  const root = arg("root", "/nfs_share/custom_nodes")!;
  const apply = process.argv.includes("--apply");
  const catalogPaths = (arg("catalog-nfs-paths", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

  const dirents = await fsp.readdir(root, { withFileTypes: true }).catch((e) => {
    console.error(`cannot read ${root}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
    return [] as never;
  });
  const entries: CustomNodeEntry[] = dirents.map((d) => ({ name: d.name, isSymlink: d.isSymbolicLink() }));

  const plan = planCaseDedup(entries, catalogPaths, root);
  if (!plan.actions.length && !plan.ambiguous.length) {
    console.log(`no case-duplicate custom-node dirs under ${root}`);
    return;
  }

  console.log(`== case-dedup plan for ${root} (${apply ? "APPLY" : "dry-run"}) ==`);
  for (const a of plan.actions) {
    console.log(`  keep '${a.keep}' (${a.reason}); remove: ${a.remove.join(", ")}`);
  }
  for (const amb of plan.ambiguous) {
    console.log(`  SKIP (ambiguous) [${amb.key}]: ${amb.names.join(", ")} — ${amb.reason}`);
  }

  if (!apply) {
    console.log(`\n(dry-run) re-run with --apply to remove ${plan.actions.reduce((n, a) => n + a.remove.length, 0)} duplicate dir(s).`);
    return;
  }
  let removed = 0;
  for (const a of plan.actions) {
    for (const name of a.remove) {
      const target = path.join(root, name);
      await fsp.rm(target, { recursive: true, force: true });
      console.log(`  removed ${target}`);
      removed++;
    }
  }
  console.log(`== removed ${removed} duplicate dir(s) ==`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
