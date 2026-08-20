/**
 * xpuCatalogClient — how the agent (on any node) reads/writes the XPU-support
 * catalog. All access goes through the single catalog-server over HTTP; agents
 * never open the SQLite index or commit git themselves.
 *
 * Resilience: if the catalog-server is unreachable (down, or this node is
 * partitioned from 172.16.124.12), reads fall back to the `/nfs_share` working
 * clone JSON directly (possibly stale, read-only) so a migration never
 * hard-blocks on the catalog API. Writes have no offline path — they are queued
 * by the caller and retried (P2/P4).
 *
 * P1 = read path (resolveNodeType / resolveRepo / getByKey with fallback). Write
 * methods (upsertCandidate / appendValidation / promote / lease) land in P2.
 */
import fs from "node:fs";
import path from "node:path";
import {
  nodeKeyFromRepo,
  type CatalogTier,
  type CatalogValidationEvidence,
  type XpuNodeRecord
} from "../catalog/schema";

/** The catalog integration is opt-in (deploy dark). Off ⇒ resolve/write are no-ops. */
export function catalogEnabled(): boolean {
  return process.env.XPU_CATALOG_ENABLED === "1" || process.env.XPU_CATALOG_ENABLED === "true";
}

export type ResolveSource = "server" | "fallback";

export interface CatalogResolve {
  record: XpuNodeRecord;
  matchedPrefix?: string;
  source: ResolveSource;
}

function serverUrl(): string {
  return (process.env.XPU_CATALOG_SERVER_URL ?? "http://172.16.124.12:3100").replace(/\/+$/, "");
}

function fallbackNodesDir(): string {
  const dataDir = process.env.XPU_CATALOG_DATA_DIR ?? "/nfs_share/migration-knowledge/xpu-catalog";
  return path.join(dataDir, "nodes");
}

const TIER_RANK: Record<CatalogTier, number> = { trusted: 3, candidate: 2, unsupported: 1 };
const TIMEOUT_MS = Number(process.env.XPU_CATALOG_TIMEOUT_MS ?? 4000);

async function tryServer(query: string): Promise<CatalogResolve | null | undefined> {
  // Returns: resolve on hit, null on a clean 404, undefined on a transport error
  // (so the caller knows to fall back rather than treat it as "not found").
  try {
    const res = await fetch(`${serverUrl()}/api/xpu-catalog/resolve?${query}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const body = (await res.json()) as { found: boolean; record?: XpuNodeRecord; matchedPrefix?: string };
    if (!body.found || !body.record) return null;
    return { record: body.record, matchedPrefix: body.matchedPrefix, source: "server" };
  } catch {
    return undefined; // transport error → fall back
  }
}

/** Read the working-clone JSON directly (offline fallback). */
function loadFallbackRecords(): XpuNodeRecord[] {
  const dir = fallbackNodesDir();
  if (!fs.existsSync(dir)) return [];
  const out: XpuNodeRecord[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as XpuNodeRecord);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function fallbackResolveByNodeType(nodeType: string): CatalogResolve | null {
  const matches: Array<{ rec: XpuNodeRecord; prefix: string }> = [];
  for (const rec of loadFallbackRecords()) {
    for (const prefix of rec.nodeTypePrefixes) {
      if (nodeType.startsWith(prefix)) matches.push({ rec, prefix });
    }
  }
  if (matches.length === 0) return null;
  matches.sort(
    (a, b) => TIER_RANK[b.rec.tier] - TIER_RANK[a.rec.tier] || b.prefix.length - a.prefix.length
  );
  return { record: matches[0].rec, matchedPrefix: matches[0].prefix, source: "fallback" };
}

function fallbackResolveByKey(nodeKey: string): CatalogResolve | null {
  const rec = loadFallbackRecords().find((r) => r.nodeKey === nodeKey);
  return rec ? { record: rec, source: "fallback" } : null;
}

/** Resolve the best catalog record for a workflow node's class_type. */
export async function resolveNodeType(nodeType: string): Promise<CatalogResolve | null> {
  if (!nodeType) return null;
  const fromServer = await tryServer(`nodeType=${encodeURIComponent(nodeType)}`);
  if (fromServer !== undefined) return fromServer; // hit or clean 404
  return fallbackResolveByNodeType(nodeType); // transport error → offline JSON
}

/** Resolve by clone/repo URL. */
export async function resolveRepo(repo: string): Promise<CatalogResolve | null> {
  if (!repo) return null;
  const fromServer = await tryServer(`repo=${encodeURIComponent(repo)}`);
  if (fromServer !== undefined) return fromServer;
  return fallbackResolveByKey(nodeKeyFromRepo(repo));
}

/** Fetch a specific record by key (server, then offline JSON). */
export async function getByKey(nodeKey: string): Promise<XpuNodeRecord | null> {
  try {
    const res = await fetch(`${serverUrl()}/api/xpu-catalog/nodes/${encodeURIComponent(nodeKey)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 404) return null;
    if (res.ok) return (await res.json()) as XpuNodeRecord;
  } catch {
    /* fall through to offline */
  }
  return fallbackResolveByKey(nodeKey)?.record ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write path — best-effort. Writes have NO offline path; on failure the caller
// still has the on-disk NN-catalog-writeback.json artifact to replay later, so a
// failed write is logged and skipped, never fatal to a migration.
// ─────────────────────────────────────────────────────────────────────────────

async function postJson(pathSuffix: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(`${serverUrl()}${pathSuffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    return null;
  }
}

/** Create/replace a record (structural upsert). Returns the stored record or null on failure/conflict. */
export async function upsertRecord(record: XpuNodeRecord): Promise<XpuNodeRecord | null> {
  const res = await postJson("/api/xpu-catalog/nodes", record);
  if (!res || !res.ok) return null;
  return (await res.json()) as XpuNodeRecord;
}

/** Append validation evidence (append-merge, idempotent server-side). */
export async function appendValidation(
  nodeKey: string,
  evidence: CatalogValidationEvidence,
  opts: { backfillRepository?: string; backfillNfsPath?: string } = {}
): Promise<XpuNodeRecord | null> {
  const res = await postJson(`/api/xpu-catalog/nodes/${encodeURIComponent(nodeKey)}/validation`, {
    evidence,
    ...opts
  });
  if (!res || !res.ok) return null;
  return (await res.json()) as XpuNodeRecord;
}

export interface LeaseResult {
  granted: boolean;
  leaseId?: string;
  holder?: string;
  ttlSec?: number;
}

/** Acquire a per-nodeKey migration lease. granted=false ⇒ another agent holds it (wait+reuse). */
export async function acquireLease(nodeKey: string, holder: string, ttlSec = 600): Promise<LeaseResult> {
  const res = await postJson(`/api/xpu-catalog/nodes/${encodeURIComponent(nodeKey)}/lease`, { holder, ttlSec });
  if (!res) return { granted: false };
  const body = (await res.json()) as LeaseResult;
  return body;
}

/** Extend the clone-lease during a long clone/patch window (keeps TTL from reclaiming it). */
export async function heartbeatLease(nodeKey: string, leaseId: string, ttlSec = 600): Promise<boolean> {
  const res = await postJson(`/api/xpu-catalog/nodes/${encodeURIComponent(nodeKey)}/lease/heartbeat`, { leaseId, ttlSec });
  if (!res || !res.ok) return false;
  try {
    return Boolean(((await res.json()) as { ok?: boolean }).ok);
  } catch {
    return false;
  }
}

export async function releaseLease(nodeKey: string, leaseId: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl()}/api/xpu-catalog/nodes/${encodeURIComponent(nodeKey)}/lease`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    return res.ok ? Boolean((await res.json()).released) : false;
  } catch {
    return false;
  }
}
