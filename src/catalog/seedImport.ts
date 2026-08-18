/**
 * Seed the XPU-support catalog from the two existing knowledge stores so the
 * catalog has day-one parity with what the agent already knows:
 *   - recipes/nodes/*.json         (recipe.schema.json — runtime XPU knowledge)
 *   - src/server/knownCustomNodes.ts (deterministic provisioning map)
 *
 * One record per *package* (keyed by nodeKey). A recipe whose nodeType belongs
 * to a known package merges into that package's record; core-node recipes with
 * no resolvable package repo get a `comfyui-core__<recipeId>` key + empty repo.
 *
 * This is a pure builder (`buildSeedRecords`) + a writer (`writeSeedRecords`);
 * the catalog-server / a CLI import both call it. No network, no git.
 */
import fs from "node:fs";
import path from "node:path";
import { loadAllRecipes, type Recipe } from "../server/recipeLibrary";
import { KNOWN_CUSTOM_NODES, knownCustomNodeForType } from "../server/knownCustomNodes";
import {
  XPU_NODE_SCHEMA_VERSION,
  nodeKeyFromRepo,
  packageNameFromRepo,
  type XpuNodeRecord,
  type ExecutionTarget,
  type XpuSupport
} from "./schema";

/** Shared custom_nodes tree root (matches assetAcquisition / install-enum-package). */
const NFS_CUSTOM_NODES_ROOT = process.env.NFS_CUSTOM_NODES_ROOT ?? "/nfs_share/custom_nodes";

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Where a recipe's package lives, if we can determine it. */
function resolveRepoForRecipe(recipe: Recipe): { nodeKey: string; repository: string; packageName: string } {
  const repo = recipe.packageRepo ?? knownCustomNodeForType(recipe.nodeType)?.repository;
  if (repo) {
    return { nodeKey: nodeKeyFromRepo(repo), repository: repo, packageName: packageNameFromRepo(repo) };
  }
  // Core node (e.g. a comfy/ops.py patch) or a package with no recorded repo:
  // keep the knowledge under a synthetic core key so resolve-by-nodeType still works.
  return { nodeKey: `comfyui-core__${slug(recipe.recipeId)}`, repository: "", packageName: "comfyui-core" };
}

function executionFor(xpuSupport: XpuSupport, pipBackendCpu: boolean): ExecutionTarget {
  if (pipBackendCpu || xpuSupport === "cpu_offload") return "cpu";
  return "xpu";
}

function blankRecord(nodeKey: string, repository: string, packageName: string, now: string): XpuNodeRecord {
  return {
    schemaVersion: XPU_NODE_SCHEMA_VERSION,
    nodeKey,
    packageName,
    repository,
    nodeTypePrefixes: [],
    execution: "xpu",
    xpuSupport: "unknown",
    tier: "candidate",
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Add a class_type prefix, keeping the set MINIMAL: skip a prefix already covered
 * by a broader existing one, and drop existing prefixes the new (broader) one
 * covers. So knownCustomNodes' broad `llama_cpp_` subsumes a recipe's exact
 * `llama_cpp_model_loader` rather than storing both.
 */
function addPrefix(record: XpuNodeRecord, prefix: string): void {
  if (!prefix) return;
  if (record.nodeTypePrefixes.some((p) => prefix.startsWith(p))) return;
  record.nodeTypePrefixes = record.nodeTypePrefixes.filter((p) => !p.startsWith(prefix));
  record.nodeTypePrefixes.push(prefix);
}

/**
 * Build the seed records in memory (deterministic apart from the timestamp,
 * which the caller may pin for tests). Merges knownCustomNodes + recipes by
 * nodeKey; one record per package.
 */
export function buildSeedRecords(nowIso: string = new Date().toISOString()): XpuNodeRecord[] {
  const byKey = new Map<string, XpuNodeRecord>();

  // 1. knownCustomNodes — the curated provisioning layer (trusted).
  for (const known of KNOWN_CUSTOM_NODES) {
    const nodeKey = nodeKeyFromRepo(known.repository);
    const rec = byKey.get(nodeKey) ?? blankRecord(nodeKey, known.repository, known.packageName, nowIso);
    rec.packageName = known.packageName;
    known.nodeTypePrefixes.forEach((p) => addPrefix(rec, p));
    if (known.modelSubdir) rec.modelSubdir = known.modelSubdir;
    if (known.pip) {
      rec.pip = {
        backend: known.pip.backend,
        skipRequirementsTxt: known.pip.skipRequirementsTxt,
        note: known.pip.note
      };
    }
    rec.onNfsShare = true;
    rec.nfsPath = `${NFS_CUSTOM_NODES_ROOT}/${known.packageName}`;
    rec.symlinkModel = true;
    rec.execution = executionFor(rec.xpuSupport, known.pip?.backend === "cpu");
    rec.tier = "trusted";
    rec.promotedBy = "seed:knownCustomNodes";
    byKey.set(nodeKey, rec);
  }

  // 2. recipes/nodes/*.json — the runtime XPU-support layer.
  const { recipes } = loadAllRecipes();
  for (const recipe of recipes) {
    const { nodeKey, repository, packageName } = resolveRepoForRecipe(recipe);
    const rec = byKey.get(nodeKey) ?? blankRecord(nodeKey, repository, packageName, nowIso);
    if (!rec.repository && repository) rec.repository = repository;

    addPrefix(rec, recipe.nodeType);
    rec.xpuSupport = recipe.xpuSupport;
    if (recipe.patchClass) rec.patchClass = recipe.patchClass;
    if (recipe.patchFile) {
      rec.patches = [
        {
          file: recipe.patchFile,
          target: recipe.patchTarget,
          patchClass: recipe.patchClass,
          baseVersion: recipe.baseVersion,
          validationCommand: recipe.validationCommand
        }
      ];
    }
    if (recipe.providesEnumValues?.length) rec.providesEnumValues = recipe.providesEnumValues;
    if (recipe.enumSlots?.length) rec.enumSlots = recipe.enumSlots;
    if (recipe.knownIssues?.length) rec.knownIssues = recipe.knownIssues;
    if (recipe.workarounds?.length) {
      rec.workarounds = recipe.workarounds.map((w) => ({
        action: w.action,
        rationale: w.rationale,
        tradeoff: w.tradeoff
      }));
    }
    if (recipe.retireCondition) rec.retireCondition = recipe.retireCondition;
    if (recipe.efficacy) {
      rec.efficacy = {
        appliedCount: recipe.efficacy.appliedCount,
        successCount: recipe.efficacy.successCount,
        lastAppliedAt: recipe.efficacy.lastAppliedAt
      };
    }
    // validatedOnWorkflows → append-only validation evidence.
    const passedAt = recipe.efficacy?.lastAppliedAt ?? `${recipe.provenance?.createdAt ?? nowIso.slice(0, 10)}T00:00:00Z`;
    if (recipe.validatedOnWorkflows?.length) {
      rec.validation = recipe.validatedOnWorkflows.map((taskId) => ({
        taskId,
        nodeType: recipe.nodeType,
        historyResult: "success",
        passed: true,
        passedAt
      }));
    }
    rec.execution = executionFor(rec.xpuSupport, rec.pip?.backend === "cpu");
    rec.originTaskId = recipe.provenance?.taskOrigin;
    // Human-approved + validated recipes seed as trusted; otherwise candidate.
    if (recipe.provenance?.approvedBy) {
      rec.tier = "trusted";
      rec.promotedBy = `seed:recipe:${recipe.provenance.approvedBy}`;
      rec.promotedAt = passedAt;
    }
    rec.updatedAt = nowIso;
    byKey.set(nodeKey, rec);
  }

  // Finalize: any package with a real repo lives on the shared tree — record its
  // /nfs_share path (both "where to clone from" and "where it lives locally").
  for (const rec of byKey.values()) {
    if (rec.repository && !rec.nfsPath) {
      rec.onNfsShare = true;
      rec.nfsPath = `${NFS_CUSTOM_NODES_ROOT}/${rec.packageName}`;
      if (rec.symlinkModel === undefined) rec.symlinkModel = true;
    }
  }

  return [...byKey.values()].sort((a, b) => a.nodeKey.localeCompare(b.nodeKey));
}

/** Write one nodes/<nodeKey>.json per record into `nodesDir`. Returns paths written. */
export function writeSeedRecords(nodesDir: string, records: XpuNodeRecord[] = buildSeedRecords()): string[] {
  fs.mkdirSync(nodesDir, { recursive: true });
  const written: string[] = [];
  for (const rec of records) {
    const file = path.join(nodesDir, `${rec.nodeKey}.json`);
    fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n", "utf8");
    written.push(file);
  }
  return written;
}
