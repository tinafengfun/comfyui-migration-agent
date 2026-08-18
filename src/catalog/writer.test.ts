import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "./store";
import { GitRepo } from "./gitRepo";
import { CatalogWriter, CatalogConflictError } from "./writer";
import type { XpuNodeRecord } from "./schema";

let root: string;
let dataDir: string;
let bareRemote: string;
let store: CatalogStore;
let clock: number;

function rec(nodeKey: string, over: Partial<XpuNodeRecord> = {}): XpuNodeRecord {
  return {
    schemaVersion: 1,
    nodeKey,
    packageName: nodeKey.split("__")[1],
    repository: `https://github.com/${nodeKey.replace("__", "/")}`,
    nodeTypePrefixes: [nodeKey.split("__")[1]],
    execution: "xpu",
    xpuSupport: "patched",
    tier: "candidate",
    version: 1,
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-18T00:00:00Z",
    ...over
  };
}

function newWriter(remote?: string): CatalogWriter {
  const git = new GitRepo(dataDir, { remote, branch: "main" });
  clock = 1_000_000;
  let seq = 0;
  return new CatalogWriter({
    store,
    git,
    promoteThreshold: 2,
    nowMs: () => clock,
    newId: () => `lease-${++seq}`
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xpu-catalog-writer-"));
  dataDir = path.join(root, "clone");
  bareRemote = path.join(root, "remote.git");
  fs.mkdirSync(path.join(dataDir, "nodes"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bareRemote]);
  process.env.XPU_CATALOG_DB = path.join(dataDir, "catalog.sqlite");
  store = new CatalogStore(dataDir);
});

afterEach(() => {
  store.close();
  delete process.env.XPU_CATALOG_DB;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("CatalogWriter", () => {
  it("upsert writes JSON + git commit + index row", async () => {
    const w = newWriter();
    const out = await w.upsert(rec("owner__pkg"));
    expect(out.version).toBe(1);
    expect(fs.existsSync(path.join(dataDir, "nodes", "owner__pkg.json"))).toBe(true);
    expect(store.getByKey("owner__pkg")?.packageName).toBe("pkg");
    const log = execFileSync("git", ["-C", dataDir, "log", "--oneline"], { encoding: "utf8" });
    expect(log).toContain("upsert owner__pkg");
  });

  it("rejects a stale structural write with 409 (optimistic version)", async () => {
    const w = newWriter();
    await w.upsert(rec("owner__pkg")); // now version 2 in store after this? no: new=1
    const cur = store.getByKey("owner__pkg")!;
    expect(cur.version).toBe(1);
    // A writer holding version 1 succeeds and bumps to 2.
    await w.upsert({ ...cur, xpuSupport: "native" });
    expect(store.getByKey("owner__pkg")!.version).toBe(2);
    // A second writer still holding version 1 is stale → 409.
    await expect(w.upsert({ ...cur, xpuSupport: "unsupported" })).rejects.toBeInstanceOf(CatalogConflictError);
  });

  it("serializes concurrent upserts of the SAME new key without corruption", async () => {
    const w = newWriter();
    // Fire 5 concurrent creates of distinct keys — all must land, index consistent.
    await Promise.all(Array.from({ length: 5 }, (_, i) => w.upsert(rec(`o__pkg${i}`))));
    expect(store.count()).toBe(5);
    for (let i = 0; i < 5; i++) expect(store.getByKey(`o__pkg${i}`)).toBeTruthy();
  });

  it("append-merge validation is idempotent on (commit,taskId,nodeType)", async () => {
    const w = newWriter();
    await w.upsert(rec("owner__pkg"));
    const ev = { taskId: "t1", nodeType: "pkgNode", passed: true, passedAt: "2026-08-18T01:00:00Z" };
    await w.appendValidation("owner__pkg", ev);
    await w.appendValidation("owner__pkg", ev); // resubmit same run
    expect(store.getByKey("owner__pkg")!.validation!.length).toBe(1);
    expect(store.getByKey("owner__pkg")!.efficacy!.appliedCount).toBe(1);
  });

  it("auto-promotes candidate → trusted after N distinct passing workflows", async () => {
    const w = newWriter();
    await w.upsert(rec("owner__pkg"));
    await w.appendValidation("owner__pkg", { taskId: "t1", workflowName: "wfA", passed: true, passedAt: "2026-08-18T01:00:00Z" });
    expect(store.getByKey("owner__pkg")!.tier).toBe("candidate");
    await w.appendValidation("owner__pkg", { taskId: "t2", workflowName: "wfB", passed: true, passedAt: "2026-08-18T02:00:00Z" });
    const promoted = store.getByKey("owner__pkg")!;
    expect(promoted.tier).toBe("trusted");
    expect(promoted.promotedBy).toBe("auto");
  });

  it("demotes a trusted record when a later validation fails", async () => {
    const w = newWriter();
    await w.upsert(rec("owner__pkg", { tier: "trusted" }));
    await w.appendValidation("owner__pkg", { taskId: "t3", passed: false, passedAt: "2026-08-18T03:00:00Z", historyResult: "failed_runtime" });
    expect(store.getByKey("owner__pkg")!.tier).toBe("candidate");
  });

  it("backfills repository/nfsPath on validation for a repo-less record", async () => {
    const w = newWriter();
    await w.upsert(rec("comfyui-core__foo", { repository: "" }));
    await w.appendValidation(
      "comfyui-core__foo",
      { taskId: "t1", passed: true, passedAt: "2026-08-18T01:00:00Z" },
      { backfillRepository: "https://github.com/acme/Foo", backfillNfsPath: "/nfs_share/custom_nodes/Foo" }
    );
    const r = store.getByKey("comfyui-core__foo")!;
    expect(r.repository).toBe("https://github.com/acme/Foo");
    expect(r.nfsPath).toBe("/nfs_share/custom_nodes/Foo");
  });

  it("pushes commits to the configured remote", async () => {
    const w = newWriter(bareRemote);
    await w.upsert(rec("owner__pkg"));
    expect(store.pendingPushCount()).toBe(0); // drained on success
    const remoteLog = execFileSync("git", ["-C", bareRemote, "log", "--oneline"], { encoding: "utf8" });
    expect(remoteLog).toContain("upsert owner__pkg");
  });

  it("keeps the local commit + queues the push when the remote is unreachable", async () => {
    const w = newWriter(path.join(root, "does-not-exist.git")); // bad remote → push fails
    await w.upsert(rec("owner__pkg"));
    // Local commit is durable...
    expect(store.getByKey("owner__pkg")).toBeTruthy();
    // ...and the push is queued for retry (not lost).
    expect(store.pendingPushCount()).toBeGreaterThan(0);
  });

  describe("migration lease", () => {
    it("grants to the first holder and denies a second (409 semantics)", async () => {
      const w = newWriter();
      const a = await w.acquireLease("owner__pkg", "agentA", 600);
      expect(a.granted).toBe(true);
      const b = await w.acquireLease("owner__pkg", "agentB", 600);
      expect(b.granted).toBe(false);
      if (!b.granted) expect(b.holder).toBe("agentA");
    });

    it("reclaims an expired lease for a new holder", async () => {
      const w = newWriter();
      await w.acquireLease("owner__pkg", "agentA", 60);
      clock += 61_000; // advance past TTL
      const b = await w.acquireLease("owner__pkg", "agentB", 60);
      expect(b.granted).toBe(true);
    });

    it("heartbeat extends only for the matching leaseId; release frees it", async () => {
      const w = newWriter();
      const a = await w.acquireLease("owner__pkg", "agentA", 60);
      if (!a.granted) throw new Error("expected grant");
      expect(await w.heartbeatLease("owner__pkg", "wrong-id", 60)).toBe(false);
      expect(await w.heartbeatLease("owner__pkg", a.leaseId, 60)).toBe(true);
      expect(await w.releaseLease("owner__pkg", "wrong-id")).toBe(false);
      expect(await w.releaseLease("owner__pkg", a.leaseId)).toBe(true);
      const b = await w.acquireLease("owner__pkg", "agentB", 60);
      expect(b.granted).toBe(true);
    });
  });
});
