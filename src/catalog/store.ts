/**
 * Catalog store — the SQLite index over the git-JSON working clone.
 *
 * Authoritative data = nodes/<nodeKey>.json in the working clone (a checkout of
 * the independent comfyui-xpu-catalog repo). SQLite is a rebuildable INDEX for
 * fast query/resolve at 100+ nodes; it is thrown away and rebuilt from JSON on
 * open. Only the catalog-server process opens this store (single writer); agents
 * are HTTP clients (see xpuCatalogClient.ts).
 *
 * P1 = read path (open / rebuildFromJson / getByKey / resolve / list). The write
 * path (upsert / append validation / promote / lease) lands in P2 and reuses the
 * same DB handle + working-clone dir.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { nodeKeyFromRepo, type CatalogTier, type XpuNodeRecord } from "./schema";

// Suppress the node:sqlite ExperimentalWarning once (same as analyticsDb.ts).
const originalEmit = process.emitWarning;
process.emitWarning = function (warning: unknown, ...rest: unknown[]): boolean {
  if (typeof warning === "string" && warning.includes("SQLite is an experimental feature")) return false;
  // @ts-expect-error forward overloads
  return originalEmit.call(process, warning, ...rest);
};

/** Default working-clone dir (git checkout + sqlite live here, resident on /nfs_share). */
export function defaultCatalogDataDir(): string {
  return process.env.XPU_CATALOG_DATA_DIR ?? "/nfs_share/migration-knowledge/xpu-catalog";
}

export interface ResolveResult {
  record: XpuNodeRecord;
  /** Which nodeTypePrefix matched (for resolve-by-nodeType). */
  matchedPrefix?: string;
}

const TIER_RANK: Record<CatalogTier, number> = { trusted: 3, candidate: 2, unsupported: 1 };

export interface LeaseRow {
  node_key: string;
  holder: string;
  lease_id: string;
  acquired_at: number;
  expires_at: number;
  heartbeat_at: number;
}

export class CatalogStore {
  readonly dataDir: string;
  readonly nodesDir: string;
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(dataDir: string = defaultCatalogDataDir()) {
    this.dataDir = dataDir;
    this.nodesDir = path.join(dataDir, "nodes");
    this.dbPath = process.env.XPU_CATALOG_DB ?? path.join(dataDir, "catalog.sqlite");
    fs.mkdirSync(this.nodesDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        node_key TEXT PRIMARY KEY,
        package_name TEXT,
        repository TEXT,
        tier TEXT NOT NULL,
        execution TEXT,
        xpu_support TEXT,
        version INTEGER NOT NULL,
        updated_at TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node_prefixes (
        node_key TEXT NOT NULL,
        prefix TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_node_prefixes_prefix ON node_prefixes(prefix);
      CREATE INDEX IF NOT EXISTS idx_node_prefixes_key ON node_prefixes(node_key);

      CREATE TABLE IF NOT EXISTS leases (
        node_key TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha TEXT,
        enqueued_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
    `);
  }

  // ── Lease rows (time logic lives in the writer/LeaseManager) ──────────────
  getLeaseRow(nodeKey: string): LeaseRow | undefined {
    return this.db.prepare("SELECT * FROM leases WHERE node_key = ?").get(nodeKey) as
      | LeaseRow
      | undefined;
  }

  upsertLeaseRow(row: LeaseRow): void {
    this.db
      .prepare(
        `INSERT INTO leases (node_key, holder, lease_id, acquired_at, expires_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_key) DO UPDATE SET
           holder=excluded.holder, lease_id=excluded.lease_id, acquired_at=excluded.acquired_at,
           expires_at=excluded.expires_at, heartbeat_at=excluded.heartbeat_at`
      )
      .run(row.node_key, row.holder, row.lease_id, row.acquired_at, row.expires_at, row.heartbeat_at);
  }

  deleteLeaseRow(nodeKey: string): void {
    this.db.prepare("DELETE FROM leases WHERE node_key = ?").run(nodeKey);
  }

  // ── Push queue (writer drains it after each commit) ───────────────────────
  enqueuePush(sha: string, enqueuedAt: string): void {
    this.db.prepare("INSERT INTO push_queue (sha, enqueued_at) VALUES (?, ?)").run(sha, enqueuedAt);
  }

  pendingPushCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM push_queue").get() as { c: number }).c;
  }

  clearPushQueue(): void {
    this.db.exec("DELETE FROM push_queue");
  }

  recordPushError(message: string): void {
    this.db.prepare("UPDATE push_queue SET attempts = attempts + 1, last_error = ?").run(message);
  }

  close(): void {
    this.db.close();
  }

  /** Wipe the index and rebuild it from every nodes/<key>.json in the working clone. */
  rebuildFromJson(): number {
    this.db.exec("DELETE FROM nodes; DELETE FROM node_prefixes;");
    let count = 0;
    if (!fs.existsSync(this.nodesDir)) return 0;
    for (const file of fs.readdirSync(this.nodesDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.nodesDir, file), "utf8")) as XpuNodeRecord;
        this.indexRecord(rec);
        count++;
      } catch {
        // A malformed JSON in the working clone must not take the whole index down.
      }
    }
    return count;
  }

  /** Upsert a record into the index (not the JSON file — that is the writer's job in P2). */
  indexRecord(rec: XpuNodeRecord): void {
    this.db
      .prepare(
        `INSERT INTO nodes (node_key, package_name, repository, tier, execution, xpu_support, version, updated_at, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_key) DO UPDATE SET
           package_name=excluded.package_name, repository=excluded.repository, tier=excluded.tier,
           execution=excluded.execution, xpu_support=excluded.xpu_support, version=excluded.version,
           updated_at=excluded.updated_at, json=excluded.json`
      )
      .run(
        rec.nodeKey,
        rec.packageName,
        rec.repository ?? "",
        rec.tier,
        rec.execution,
        rec.xpuSupport,
        rec.version,
        rec.updatedAt,
        JSON.stringify(rec)
      );
    this.db.prepare("DELETE FROM node_prefixes WHERE node_key = ?").run(rec.nodeKey);
    const ins = this.db.prepare("INSERT INTO node_prefixes (node_key, prefix) VALUES (?, ?)");
    for (const prefix of rec.nodeTypePrefixes) ins.run(rec.nodeKey, prefix);
  }

  getByKey(nodeKey: string): XpuNodeRecord | undefined {
    const row = this.db.prepare("SELECT json FROM nodes WHERE node_key = ?").get(nodeKey) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as XpuNodeRecord) : undefined;
  }

  resolveByRepo(repo: string): ResolveResult | undefined {
    const rec = this.getByKey(nodeKeyFromRepo(repo));
    return rec ? { record: rec } : undefined;
  }

  /**
   * Resolve the best record for a workflow node's class_type: any prefix that is a
   * prefix of `nodeType`. Ties broken by tier (trusted > candidate > unsupported),
   * then by longest (most specific) matching prefix.
   */
  resolveByNodeType(nodeType: string): ResolveResult | undefined {
    if (!nodeType) return undefined;
    const rows = this.db
      .prepare(
        `SELECT p.node_key AS nodeKey, p.prefix AS prefix, n.tier AS tier, n.json AS json
         FROM node_prefixes p JOIN nodes n ON n.node_key = p.node_key
         WHERE ? LIKE p.prefix || '%'`
      )
      .all(nodeType) as Array<{ nodeKey: string; prefix: string; tier: CatalogTier; json: string }>;
    if (rows.length === 0) return undefined;
    rows.sort(
      (a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.prefix.length - a.prefix.length
    );
    return { record: JSON.parse(rows[0].json) as XpuNodeRecord, matchedPrefix: rows[0].prefix };
  }

  list(filter: { tier?: CatalogTier; xpuSupport?: string; nodeType?: string } = {}): XpuNodeRecord[] {
    if (filter.nodeType) {
      const r = this.resolveByNodeType(filter.nodeType);
      return r ? [r.record] : [];
    }
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.tier) {
      clauses.push("tier = ?");
      args.push(filter.tier);
    }
    if (filter.xpuSupport) {
      clauses.push("xpu_support = ?");
      args.push(filter.xpuSupport);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT json FROM nodes ${where} ORDER BY node_key`)
      .all(...args) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as XpuNodeRecord);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
  }
}
