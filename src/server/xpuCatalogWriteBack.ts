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
import type { NodeVerdict } from "./nodeValidationRunner";

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
  supportedDtypes?: string[];
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
    ...(entry.supportedDtypes?.length ? { supportedDtypes: entry.supportedDtypes } : {}),
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
  return applyEntries(entries, ctx);
}

/**
 * Apply already-composed write-back entries (shared by the artifact path above and
 * the ledger path below). For an EXISTING record only APPENDS evidence (no
 * structural 409); a new node is created as a `candidate` first. Best-effort.
 */
export async function applyEntries(
  entries: CatalogWriteBackEntry[],
  ctx: { taskId?: string; workflowName?: string } = {}
): Promise<WriteBackSummary> {
  const summary: WriteBackSummary = { enabled: catalogEnabled(), created: [], validated: [], skipped: [] };
  if (!summary.enabled) return summary;
  const nowIso = new Date().toISOString();

  for (const entry of entries) {
    const nodeKey = entryNodeKey(entry);
    if (!nodeKey || !entry.evidence) {
      summary.skipped.push(nodeKey ?? "(no key)");
      continue;
    }
    // Enrich evidence with task/workflow context if the caller didn't.
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

// ─────────────────────────────────────────────────────────────────────────────
// Plan B: compose write-back from a Step-05 deploy ledger + isolated harness
// verdicts (backend-driven; no agent-emitted artifact).
// ─────────────────────────────────────────────────────────────────────────────

/** One deployed custom node, recorded by Step 05 (what the agent actually applied). */
export interface CatalogDeployLedgerNode {
  nodeType: string;
  nodeKey?: string;
  repository?: string;
  packageName?: string;
  nfsPath?: string;
  commit?: string;
  /** The model dtype this node was deployed/used with (→ record.supportedDtypes). */
  dtype?: string;
  execution?: ExecutionTarget;
  xpuSupport?: XpuSupport;
  patches?: XpuNodeRecord["patches"];
  pip?: XpuNodeRecord["pip"];
}
export interface CatalogDeployLedger {
  nodes: CatalogDeployLedgerNode[];
}
export const CATALOG_DEPLOY_LEDGER_FILE = "05-catalog-deploy-ledger.json";

/** Join a deploy ledger with per-node harness verdicts → write-back entries. Pure. */
export function composeEntriesFromLedger(
  ledger: CatalogDeployLedger,
  verdicts: NodeVerdict[],
  ctx: { taskId?: string; workflowName?: string; nowIso?: string } = {}
): CatalogWriteBackEntry[] {
  const nowIso = ctx.nowIso ?? new Date().toISOString();
  const nodes = ledger?.nodes ?? [];
  const byType = new Map(nodes.map((n) => [n.nodeType, n]));
  const entries: CatalogWriteBackEntry[] = [];
  for (const v of verdicts) {
    const led = byType.get(v.nodeType) ?? nodes.find((n) => v.nodeType.startsWith(n.nodeType));
    if (!led) continue; // no deploy record → can't key this node
    if (!led.nodeKey && !led.repository) continue; // lazy-backfill needs a repo/key
    entries.push({
      nodeKey: led.nodeKey,
      repository: led.repository,
      packageName: led.packageName,
      nfsPath: led.nfsPath,
      commit: led.commit,
      execution: led.execution,
      xpuSupport: led.xpuSupport,
      patches: led.patches,
      pip: led.pip,
      supportedDtypes: led.dtype ? [led.dtype] : undefined,
      evidence: {
        nodeType: v.nodeType,
        passed: v.passed,
        historyResult: v.historyResult,
        xpuUtilizationPct: v.xpuUtilizationPct ?? undefined,
        peakVramRatio: v.peakMemoryBudgetRatio ?? undefined,
        passedAt: v.passedAt ?? nowIso,
        commit: led.commit,
        taskId: ctx.taskId,
        workflowName: ctx.workflowName
      }
    });
  }
  return entries;
}

/** Compose from ledger + verdicts, then apply. */
export async function applyCatalogWriteBackFromLedger(
  ledger: CatalogDeployLedger,
  verdicts: NodeVerdict[],
  ctx: { taskId?: string; workflowName?: string } = {}
): Promise<WriteBackSummary> {
  return applyEntries(composeEntriesFromLedger(ledger, verdicts, ctx), ctx);
}
