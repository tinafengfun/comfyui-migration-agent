#!/usr/bin/env node
/**
 * Stage 5 — build XpuNodeRecords from the parsed sheet + clone-state + harvest, write
 * them to the catalog (upsert as candidate → appendValidation → promote to trusted for
 * packages that registered on XPU), and emit knownCustomNodes.ts entries for the
 * validated ones. Non-registering / bucket-C packages are recorded `unsupported`
 * (candidate) with a knownIssue — not promoted, not faked.
 *
 * Env: XPU_CATALOG_ENABLED=1 XPU_CATALOG_SERVER_URL=http://127.0.0.1:3100
 * Usage:
 *   npx tsx scripts/catalog-import/build-records.mts --nodes nodes.json
 *     [--clone clone-state.json] [--harvest harvest.json] [--patches-dir DIR]
 *     [--known-out entries.ts] [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { XPU_NODE_SCHEMA_VERSION, nodeKeyFromRepo, packageNameFromRepo, type XpuNodeRecord } from "../../src/catalog/schema";
import { upsertRecord, appendValidation, catalogEnabled } from "../../src/server/xpuCatalogClient";

function arg(flag: string, def?: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}
const DRY = process.argv.includes("--dry-run");
const nodesPath = arg("--nodes")!;
const clonePath = arg("--clone", "/tmp/catalog-import-clone-state.json")!;
const harvestPath = arg("--harvest", "/tmp/catalog-import-harvest.json")!;
const patchesDir = arg("--patches-dir", "/tmp/catalog-import-patches")!;
const knownOut = arg("--known-out", "/tmp/catalog-import-known-entries.ts")!;
const rd = (p: string) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {});

/** Collapse a class_type list to minimal prefixes: keep a `family_` prefix when ≥2
 *  types share it (up to the first underscore), else the exact type. */
function toPrefixes(classTypes: string[]): string[] {
  const fams = new Map<string, number>();
  for (const t of classTypes) {
    const u = t.indexOf("_");
    if (u > 0) fams.set(t.slice(0, u + 1), (fams.get(t.slice(0, u + 1)) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const t of classTypes) {
    const u = t.indexOf("_");
    const fam = u > 0 ? t.slice(0, u + 1) : "";
    out.add(fam && (fams.get(fam) ?? 0) >= 2 ? fam : t);
  }
  return [...out].sort();
}

function xpuSupport(row: any, registered: boolean): XpuNodeRecord["xpuSupport"] {
  if (row.bucket === "C" || !registered) return "unsupported";
  const notes = (row.notes || "").toLowerCase();
  if (row.needs_patch) return "patched";
  if (notes.includes("cpu") || notes.includes("fallback")) return "cpu_offload";
  return "native";
}

async function main() {
  if (!catalogEnabled()) {
    console.error("XPU_CATALOG_ENABLED not set — refusing to write."); process.exit(2);
  }
  const nodes = JSON.parse(fs.readFileSync(nodesPath, "utf8")) as any[];
  const clone = rd(clonePath), harvest = rd(harvestPath);
  const now = new Date().toISOString();
  const known: string[] = [];
  let created = 0, promoted = 0, unsupported = 0;

  for (const row of nodes) {
    const pkg = row.package_name as string;
    const repo = row.repository as string;
    const nodeKey = nodeKeyFromRepo(repo);
    const h = harvest[pkg] ?? { class_types: [], registered: false };
    const cl = clone[pkg] ?? {};
    const registered = row.bucket !== "C" && !!h.registered;
    const realPrefixes = toPrefixes(h.class_types ?? []);
    // The schema requires >=1 nodeTypePrefix, but a node that didn't register on XPU
    // has no discovered class_types. Record it anyway (as candidate/unsupported, for
    // future-migration reference) under a sentinel prefix that can NEVER be a prefix
    // of a real workflow class_type — so resolveByNodeType stays correct while the
    // record remains queryable by repo and carries the failure reason.
    const prefixes = realPrefixes.length ? realPrefixes : [`__unregistered:${pkg}`];
    const patchDiff = path.join(patchesDir, `${pkg}.cuda-to-xpu.diff`);
    const hasPatch = row.needs_patch && fs.existsSync(patchDiff);
    // reason recorded on non-registering nodes (in addition to the sheet notes)
    const failReason = row.bucket === "C"
      ? "marked unsupported in custom_node_list (full-CUDA / 暂不移植)"
      : (h.timeout
        ? "did not register on XPU in batch harvest (container object_info timeout) — needs live re-validation"
        : "did not register on XPU in batch harvest (heavy compiled extension or missing pip deps; bulk pip gated off) — needs live validation");

    const rec: XpuNodeRecord = {
      schemaVersion: XPU_NODE_SCHEMA_VERSION,
      nodeKey,
      packageName: packageNameFromRepo(repo) || pkg,
      repository: repo,
      nodeTypePrefixes: prefixes,
      ...(cl.nfsPath ? { nfsPath: cl.nfsPath, onNfsShare: true } : {}),
      ...(cl.commit ? { commit: cl.commit } : {}),
      execution: "xpu",
      xpuSupport: xpuSupport(row, registered),
      ...(hasPatch ? { patchClass: "functional_runtime_support" as const,
        patches: [{ file: `catalog-import/patches/${pkg}.cuda-to-xpu.diff`, patchClass: "functional_runtime_support" as const }] } : {}),
      ...(row.bucket === "B" ? { syclWheel: { required: true } } : {}),
      ...((() => { const ki = [...(row.notes ? [row.notes] : []), ...(registered ? [] : [failReason])]; return ki.length ? { knownIssues: ki } : {}; })()),
      tier: "candidate",
      version: 1,
      originTaskId: "catalog-import-xlsx",
      createdAt: now,
      updatedAt: now,
    };

    if (DRY) { console.log(`DRY ${registered ? "REG " : "----"} ${nodeKey} prefixes=${prefixes.length} ${rec.xpuSupport}`); continue; }
    const up = await upsertRecord(rec);
    if (up) created++;
    if (registered) {
      // evidence: object_info registration on XPU (the "simple check")
      const val = await appendValidation(nodeKey, {
        nodeType: prefixes[0], passed: true, historyResult: "object_info_registered_on_xpu",
        passedAt: now, workflowName: "catalog-import:object_info", taskId: "catalog-import-xlsx",
      }, { backfillRepository: repo, backfillNfsPath: cl.nfsPath });
      // promote to trusted (human-verified sheet + registers on XPU)
      const purl = `${process.env.XPU_CATALOG_SERVER_URL ?? "http://127.0.0.1:3100"}/api/xpu-catalog/nodes/${encodeURIComponent(nodeKey)}/promote`;
      try { await fetch(purl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by: "catalog-import-xlsx" }) }); promoted++; } catch {}
      if (val) {
        // knownCustomNodes entry for the validated node
        const pip = /cuda|cu128|\+cu/i.test(row.notes || "") ? `,\n    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." }` : "";
        known.push(`  {\n    packageName: ${JSON.stringify(rec.packageName)},\n    repository: ${JSON.stringify(repo)},\n    nodeTypePrefixes: ${JSON.stringify(prefixes)}${pip},\n  },`);
      }
    } else {
      unsupported++;
    }
  }

  if (!DRY) {
    fs.writeFileSync(knownOut, `// generated by catalog-import/build-records.mts — validated nodes\n${known.join("\n")}\n`);
    console.log(`\ncreated ${created}, promoted-to-trusted ${promoted}, unsupported/failed ${unsupported}`);
    console.log(`knownCustomNodes entries (${known.length}) -> ${knownOut}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
