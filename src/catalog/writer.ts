/**
 * CatalogWriter — the single serialized writer behind the catalog-server.
 *
 * Every mutation goes through one in-process mutex (the withLock promise chain,
 * same idea as StateStore.withWriteLock). That is what makes concurrent writes
 * from many agents consistent: they queue here. Each structural write:
 *   validate schema → (pull --rebase) → write nodes/<key>.json → git commit →
 *   index into SQLite → enqueue + drain push.
 *
 * Consistency rules:
 *  - Structural upsert carries the version it read; a stale version → 409.
 *  - Validation evidence is APPEND-MERGE (idempotent on commit|taskId|nodeType),
 *    never an overwrite — concurrent appends both land, no lost update, no 409.
 *  - candidate → trusted auto-promotes at N distinct passing workflows; a failed
 *    validation on a trusted record demotes it back to candidate.
 *  - Per-nodeKey migration leases (SQLite only, not git) serialize the physical
 *    migration of a shared node across agents; TTL + heartbeat + stale reclaim.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GitRepo } from "./gitRepo";
import { CatalogStore } from "./store";
import {
  validateXpuNode,
  type CatalogValidationEvidence,
  type XpuNodeRecord
} from "./schema";

export class CatalogConflictError extends Error {
  readonly code = 409;
}
export class CatalogNotFoundError extends Error {
  readonly code = 404;
}
export class CatalogValidationError extends Error {
  readonly code = 400;
}

export interface LeaseGrant {
  granted: true;
  leaseId: string;
  ttlSec: number;
  expiresAt: number;
}
export interface LeaseDenied {
  granted: false;
  holder: string;
  since: number;
}

export interface CatalogWriterOptions {
  store: CatalogStore;
  git: GitRepo;
  /** Distinct passing workflows required to auto-promote candidate → trusted. */
  promoteThreshold?: number;
  /** Injectable clock (ms) for deterministic lease tests. */
  nowMs?: () => number;
  /** Injectable id generator for deterministic lease/id tests. */
  newId?: () => string;
}

export class CatalogWriter {
  private readonly store: CatalogStore;
  private readonly git: GitRepo;
  private readonly promoteThreshold: number;
  private readonly nowMs: () => number;
  private readonly newId: () => string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: CatalogWriterOptions) {
    this.store = opts.store;
    this.git = opts.git;
    this.promoteThreshold = opts.promoteThreshold ?? 2;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.newId = opts.newId ?? (() => randomUUID());
    this.git.ensureRepo();
  }

  /** Serialize every mutation through a single promise chain. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    // Keep the chain alive regardless of individual failures.
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private recordFile(nodeKey: string): string {
    return path.join(this.store.nodesDir, `${nodeKey}.json`);
  }

  /** validate → write JSON → commit → index → enqueue+drain push. */
  private async persist(rec: XpuNodeRecord, commitMsg: string): Promise<XpuNodeRecord> {
    const v = validateXpuNode(rec);
    if (!v.ok) throw new CatalogValidationError(`invalid record ${rec.nodeKey}: ${v.message}`);
    await this.syncBeforeWrite();
    const rel = path.relative(this.git.dir, this.recordFile(rec.nodeKey));
    fs.writeFileSync(this.recordFile(rec.nodeKey), JSON.stringify(rec, null, 2) + "\n", "utf8");
    const sha = this.git.commitPaths([rel], commitMsg);
    this.store.indexRecord(rec);
    if (sha) {
      this.store.enqueuePush(sha, this.nowIso());
      await this.drainPush();
    }
    return rec;
  }

  private async syncBeforeWrite(): Promise<void> {
    try {
      await this.git.pullRebase();
    } catch {
      // Offline / proxy down / conflict — proceed with a durable local commit;
      // the push queue carries it to GitHub when connectivity returns.
    }
  }

  /** Attempt to flush queued commits to origin. Best-effort; never throws. */
  async drainPush(): Promise<void> {
    if (this.store.pendingPushCount() === 0) return;
    try {
      await this.git.push();
      this.store.clearPushQueue();
    } catch (e) {
      this.store.recordPushError((e as Error).message.slice(0, 300));
    }
  }

  // ── Structural upsert (optimistic version) ────────────────────────────────
  /**
   * Create or replace a record. For an existing record, `input.version` must
   * equal the current version (optimistic lock) → else 409. Append-only history
   * (validation, efficacy, createdAt) is preserved unless explicitly provided.
   */
  upsert(input: XpuNodeRecord): Promise<XpuNodeRecord> {
    return this.withLock(async () => {
      const existing = this.store.getByKey(input.nodeKey);
      const now = this.nowIso();
      let rec: XpuNodeRecord;
      if (existing) {
        if (input.version !== existing.version) {
          throw new CatalogConflictError(
            `stale write for ${input.nodeKey}: had version ${input.version}, current is ${existing.version}`
          );
        }
        rec = {
          ...input,
          createdAt: existing.createdAt,
          validation: input.validation ?? existing.validation,
          efficacy: input.efficacy ?? existing.efficacy,
          version: existing.version + 1,
          updatedAt: now
        };
      } else {
        rec = { ...input, version: 1, createdAt: input.createdAt ?? now, updatedAt: now };
      }
      return this.persist(rec, `catalog: upsert ${rec.nodeKey} (v${rec.version})`);
    });
  }

  // ── Append-merge validation evidence + promotion/demotion ─────────────────
  appendValidation(
    nodeKey: string,
    evidence: CatalogValidationEvidence,
    opts: { backfillRepository?: string; backfillNfsPath?: string } = {}
  ): Promise<XpuNodeRecord> {
    return this.withLock(async () => {
      const rec = this.store.getByKey(nodeKey);
      if (!rec) throw new CatalogNotFoundError(`no record ${nodeKey}`);

      const key = (e: CatalogValidationEvidence) => `${e.commit ?? ""}|${e.taskId ?? ""}|${e.nodeType ?? ""}`;
      const already = (rec.validation ?? []).some((e) => key(e) === key(evidence));
      if (already) return rec; // idempotent — same run resubmitted, no commit

      rec.validation = [...(rec.validation ?? []), evidence];
      const eff = rec.efficacy ?? { appliedCount: 0, successCount: 0 };
      rec.efficacy = {
        appliedCount: (eff.appliedCount ?? 0) + 1,
        successCount: (eff.successCount ?? 0) + (evidence.passed ? 1 : 0),
        lastAppliedAt: evidence.passedAt
      };

      // Lazy backfill of the GitHub repo / nfs path for seed records that lacked it.
      if (opts.backfillRepository && !rec.repository) {
        rec.repository = opts.backfillRepository;
        if (!rec.nfsPath && opts.backfillNfsPath) rec.nfsPath = opts.backfillNfsPath;
        rec.onNfsShare = true;
      }

      // Demote a trusted record whose latest validation FAILED.
      if (rec.tier === "trusted" && !evidence.passed) {
        rec.tier = "candidate";
        rec.retireCondition =
          (rec.retireCondition ? rec.retireCondition + " " : "") +
          `[auto-demoted ${this.nowIso()}: validation failed on ${evidence.taskId ?? "?"}]`;
      }

      // Auto-promote a candidate once it has passed on N distinct workflows.
      if (rec.tier === "candidate" && evidence.passed && this.distinctPassedWorkflows(rec) >= this.promoteThreshold) {
        rec.tier = "trusted";
        rec.promotedBy = "auto";
        rec.promotedAt = this.nowIso();
      }

      rec.version += 1;
      rec.updatedAt = this.nowIso();
      return this.persist(rec, `catalog: validation ${nodeKey} (${evidence.passed ? "pass" : "fail"})`);
    });
  }

  private distinctPassedWorkflows(rec: XpuNodeRecord): number {
    const wf = new Set<string>();
    for (const e of rec.validation ?? []) {
      if (e.passed) wf.add(e.workflowName || e.taskId || `${e.passedAt}`);
    }
    return wf.size;
  }

  promote(nodeKey: string, by: string): Promise<XpuNodeRecord> {
    return this.withLock(async () => {
      const rec = this.store.getByKey(nodeKey);
      if (!rec) throw new CatalogNotFoundError(`no record ${nodeKey}`);
      rec.tier = "trusted";
      rec.promotedBy = by;
      rec.promotedAt = this.nowIso();
      rec.version += 1;
      rec.updatedAt = this.nowIso();
      return this.persist(rec, `catalog: promote ${nodeKey} -> trusted (by ${by})`);
    });
  }

  retire(nodeKey: string, reason: string): Promise<XpuNodeRecord> {
    return this.withLock(async () => {
      const rec = this.store.getByKey(nodeKey);
      if (!rec) throw new CatalogNotFoundError(`no record ${nodeKey}`);
      rec.tier = "unsupported";
      rec.retireCondition = reason;
      rec.version += 1;
      rec.updatedAt = this.nowIso();
      return this.persist(rec, `catalog: retire ${nodeKey}`);
    });
  }

  // ── Per-nodeKey migration lease (SQLite only, not git) ────────────────────
  acquireLease(nodeKey: string, holder: string, ttlSec: number): Promise<LeaseGrant | LeaseDenied> {
    return this.withLock(async () => {
      const now = this.nowMs();
      const row = this.store.getLeaseRow(nodeKey);
      const live = row && row.expires_at > now;
      if (live && row!.holder !== holder) {
        return { granted: false, holder: row!.holder, since: row!.acquired_at };
      }
      // No lease, expired (reclaim), or same holder (refresh).
      const leaseId = live && row!.holder === holder ? row!.lease_id : this.newId();
      const acquiredAt = live && row!.holder === holder ? row!.acquired_at : now;
      const expiresAt = now + ttlSec * 1000;
      this.store.upsertLeaseRow({
        node_key: nodeKey,
        holder,
        lease_id: leaseId,
        acquired_at: acquiredAt,
        expires_at: expiresAt,
        heartbeat_at: now
      });
      return { granted: true, leaseId, ttlSec, expiresAt };
    });
  }

  heartbeatLease(nodeKey: string, leaseId: string, ttlSec: number): Promise<boolean> {
    return this.withLock(async () => {
      const row = this.store.getLeaseRow(nodeKey);
      if (!row || row.lease_id !== leaseId) return false;
      const now = this.nowMs();
      this.store.upsertLeaseRow({ ...row, expires_at: now + ttlSec * 1000, heartbeat_at: now });
      return true;
    });
  }

  releaseLease(nodeKey: string, leaseId: string): Promise<boolean> {
    return this.withLock(async () => {
      const row = this.store.getLeaseRow(nodeKey);
      if (!row || row.lease_id !== leaseId) return false; // never release someone else's lease
      this.store.deleteLeaseRow(nodeKey);
      return true;
    });
  }
}
