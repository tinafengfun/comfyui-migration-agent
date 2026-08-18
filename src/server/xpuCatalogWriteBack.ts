/**
 * Catalog write-back — the backend-owned path that turns a validated node into a
 * catalog record (requirement: "验证通过后更新数据库，下次使用").
 *
 * The per-node harness (validate_node_xpu.py) + Step 05 emit a
 * `catalog-writeback.json` artifact of per-node evidence. The orchestrator calls
 * this after those steps; it is the SINGLE serialized writer path (agents never
 * open SQLite or commit git — they POST to the one catalog-server).
 *
 * Discipline: for an EXISTING record we only APPEND evidence (never structural
 * overwrite → no 409); a brand-new node is created as a `candidate` first, then
 * its evidence appended. Best-effort: a write failure is logged, never fatal —
 * the evidence stays on disk in the artifact to replay later. Off unless
 * XPU_CATALOG_ENABLED.
 */
import fs from "node:fs";
import path from "node:path";
import {
  XPU_NODE_SCHEMA_VERSION,
  nodeKeyFromRepo,
  packageNameFromRepo,
  type CatalogValidationEvidence,
  type ExecutionTarget,
  type XpuNodeRecord,
  type XpuSupport
} from "../catalog/schema";
import { appendValidation, catalogEnabled, getByKey, upsertRecord } from "./xpuCatalogClient";

/** One node's write-back payload (superset kept lenient; only evidence is required). */
export interface CatalogWriteBackEntry {
  nodeKey?: string;
  repository?: string;
  packageName?: string;
  nfsPath?: string;
  nodeTypePrefixes?: string[];
  commit?: string;
  execution?: ExecutionTarget;
  xpuSupport?: XpuSupport;
  patches?: XpuNodeRecord["patches"];
  pip?: XpuNodeRecord["pip"];
  syclWheel?: XpuNodeRecord["syclWheel"];
  envVars?: Record<string, string>;
  providesEnumValues?: string[];
  usableConfigs?: XpuNodeRecord["usableConfigs"];
  evidence: CatalogValidationEvidence;
}

export interface CatalogWriteBackArtifact {
  step?: string;
  nodes: CatalogWriteBackEntry[];
}

export interface WriteBackSummary {
  enabled: boolean;
  created: string[];
  validated: string[];
  skipped: string[];
}

/** Default artifact name Step 05 / the harness emit into the task artifacts dir. */
export const CATALOG_WRITEBACK_FILE = "catalog-writeback.json";

function entryNodeKey(entry: CatalogWriteBackEntry): string | undefined {
  if (entry.nodeKey) return entry.nodeKey;
  if (entry.repository) return nodeKeyFromRepo(entry.repository);
  return undefined;
}

function buildNewRecord(entry: CatalogWriteBackEntry, nodeKey: string, nowIso: string, taskId?: string): XpuNodeRecord {
  const prefixes =
    entry.nodeTypePrefixes && entry.nodeTypePrefixes.length
      ? entry.nodeTypePrefixes
      : entry.evidence.nodeType
        ? [entry.evidence.nodeType]
        : [];
  return {
    schemaVersion: XPU_NODE_SCHEMA_VERSION,
    nodeKey,
    packageName: entry.packageName ?? (entry.repository ? packageNameFromRepo(entry.repository) : nodeKey.split("__")[1]),
    repository: entry.repository ?? "",
    nodeTypePrefixes: prefixes,
    ...(entry.nfsPath ? { nfsPath: entry.nfsPath, onNfsShare: true } : {}),
    ...(entry.commit ? { commit: entry.commit } : {}),
    execution: entry.execution ?? "xpu",
    xpuSupport: entry.xpuSupport ?? "unknown",
    ...(entry.patches ? { patches: entry.patches } : {}),
    ...(entry.pip ? { pip: entry.pip } : {}),
    ...(entry.syclWheel ? { syclWheel: entry.syclWheel } : {}),
    ...(entry.envVars ? { envVars: entry.envVars } : {}),
    ...(entry.providesEnumValues ? { providesEnumValues: entry.providesEnumValues } : {}),
    ...(entry.usableConfigs ? { usableConfigs: entry.usableConfigs } : {}),
    tier: "candidate",
    version: 1,
    originTaskId: taskId,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

/**
 * Apply the write-back artifact for a task's step. Reads `<artifactPath>/<file>`
 * (default catalog-writeback.json). No-op (enabled:false) unless the catalog is on.
 */
export async function applyCatalogWriteBack(
  artifactPath: string,
  ctx: { taskId?: string; workflowName?: string; file?: string } = {}
): Promise<WriteBackSummary> {
  const summary: WriteBackSummary = { enabled: catalogEnabled(), created: [], validated: [], skipped: [] };
  if (!summary.enabled) return summary;

  const file = path.join(artifactPath, ctx.file ?? CATALOG_WRITEBACK_FILE);
  if (!fs.existsSync(file)) return summary;

  let artifact: CatalogWriteBackArtifact;
  try {
    artifact = JSON.parse(fs.readFileSync(file, "utf8")) as CatalogWriteBackArtifact;
  } catch {
    return summary;
  }
  const entries = Array.isArray(artifact?.nodes) ? artifact.nodes : [];
  const nowIso = new Date().toISOString();

  for (const entry of entries) {
    const nodeKey = entryNodeKey(entry);
    if (!nodeKey || !entry.evidence) {
      summary.skipped.push(nodeKey ?? "(no key)");
      continue;
    }
    // Enrich evidence with task/workflow context if the harness didn't.
    const evidence: CatalogValidationEvidence = {
      ...entry.evidence,
      taskId: entry.evidence.taskId ?? ctx.taskId,
      workflowName: entry.evidence.workflowName ?? ctx.workflowName
    };
    try {
      const existing = await getByKey(nodeKey);
      if (!existing) {
        const created = await upsertRecord(buildNewRecord(entry, nodeKey, nowIso, ctx.taskId));
        if (created) summary.created.push(nodeKey);
      }
      const updated = await appendValidation(nodeKey, evidence, {
        backfillRepository: entry.repository,
        backfillNfsPath: entry.nfsPath
      });
      if (updated) summary.validated.push(nodeKey);
      else summary.skipped.push(nodeKey);
    } catch {
      summary.skipped.push(nodeKey);
    }
  }
  return summary;
}
