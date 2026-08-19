import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../catalog/store";
import { GitRepo } from "../catalog/gitRepo";
import { CatalogWriter } from "../catalog/writer";
import { createCatalogApp } from "../catalog/server";
import {
  applyCatalogWriteBack,
  applyCatalogWriteBackFromLedger,
  composeEntriesFromLedger,
  type CatalogDeployLedger
} from "./xpuCatalogWriteBack";
import type { NodeVerdict } from "./nodeValidationRunner";

let root: string;
let artifactDir: string;
let store: CatalogStore;
let server: Server;

function writeArtifact(nodes: unknown[]): void {
  fs.writeFileSync(path.join(artifactDir, "catalog-writeback.json"), JSON.stringify({ step: "05", nodes }), "utf8");
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xpu-catalog-wb-"));
  artifactDir = path.join(root, "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });
  const clone = path.join(root, "clone");
  fs.mkdirSync(path.join(clone, "nodes"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", clone]);
  process.env.XPU_CATALOG_DB = path.join(clone, "catalog.sqlite");
  process.env.XPU_CATALOG_DATA_DIR = clone;
  store = new CatalogStore(clone);
  const writer = new CatalogWriter({ store, git: new GitRepo(clone, { branch: "main" }), promoteThreshold: 2 });
  await new Promise<void>((resolve) => {
    server = createCatalogApp(store, writer).listen(0, "127.0.0.1", () => {
      process.env.XPU_CATALOG_SERVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  for (const k of ["XPU_CATALOG_DB", "XPU_CATALOG_DATA_DIR", "XPU_CATALOG_SERVER_URL", "XPU_CATALOG_ENABLED"]) delete process.env[k];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("applyCatalogWriteBack", () => {
  it("is a no-op when the catalog is disabled", async () => {
    delete process.env.XPU_CATALOG_ENABLED;
    writeArtifact([{ repository: "https://github.com/acme/Foo", evidence: { nodeType: "FooNode", passed: true, passedAt: "2026-08-18T01:00:00Z" } }]);
    const s = await applyCatalogWriteBack(artifactDir, { taskId: "t1" });
    expect(s.enabled).toBe(false);
    expect(store.count()).toBe(0);
  });

  it("creates a new candidate record and appends validation evidence", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    writeArtifact([
      {
        repository: "https://github.com/acme/Foo",
        nfsPath: "/nfs_share/custom_nodes/Foo",
        nodeTypePrefixes: ["Foo"],
        xpuSupport: "patched",
        evidence: { nodeType: "FooNode", passed: true, xpuUtilizationPct: 82, passedAt: "2026-08-18T01:00:00Z" }
      }
    ]);
    const s = await applyCatalogWriteBack(artifactDir, { taskId: "t1", workflowName: "wf.json" });
    expect(s.enabled).toBe(true);
    expect(s.created).toContain("acme__foo");
    expect(s.validated).toContain("acme__foo");
    const rec = store.getByKey("acme__foo")!;
    expect(rec.tier).toBe("candidate");
    expect(rec.repository).toBe("https://github.com/acme/Foo");
    expect(rec.validation?.[0].xpuUtilizationPct).toBe(82);
    expect(rec.validation?.[0].taskId).toBe("t1"); // enriched from ctx
  });

  it("composeEntriesFromLedger joins ledger nodes with verdicts (pure; dtype→supportedDtypes; skips no-repo)", () => {
    const ledger: CatalogDeployLedger = {
      nodes: [
        { nodeType: "FooNode", repository: "https://github.com/acme/Foo", commit: "abc", dtype: "fp8_e4m3fn", xpuSupport: "patched" },
        { nodeType: "NoRepoNode" } // no repo/key → skipped
      ]
    };
    const verdicts: NodeVerdict[] = [
      { nodeType: "FooNode", passed: true, historyResult: "success", xpuUtilizationPct: 81, passedAt: "2026-08-19T01:00:00Z" },
      { nodeType: "NoRepoNode", passed: true, passedAt: "2026-08-19T01:00:00Z" },
      { nodeType: "UnknownNode", passed: true, passedAt: "2026-08-19T01:00:00Z" } // no ledger entry → skipped
    ];
    const entries = composeEntriesFromLedger(ledger, verdicts, { taskId: "t1", workflowName: "wf" });
    expect(entries).toHaveLength(1);
    expect(entries[0].repository).toBe("https://github.com/acme/Foo");
    expect(entries[0].commit).toBe("abc");
    expect(entries[0].supportedDtypes).toEqual(["fp8_e4m3fn"]);
    expect(entries[0].evidence).toMatchObject({ nodeType: "FooNode", passed: true, xpuUtilizationPct: 81, taskId: "t1", workflowName: "wf" });
  });

  it("applyCatalogWriteBackFromLedger creates a candidate with the harness verdict as evidence", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    const ledger: CatalogDeployLedger = {
      nodes: [{ nodeType: "FooNode", repository: "https://github.com/acme/Foo", commit: "abc", dtype: "fp8_e4m3fn", xpuSupport: "patched" }]
    };
    const verdicts: NodeVerdict[] = [{ nodeType: "FooNode", passed: true, xpuUtilizationPct: 81, historyResult: "success", passedAt: "2026-08-19T01:00:00Z" }];
    const s = await applyCatalogWriteBackFromLedger(ledger, verdicts, { taskId: "t1", workflowName: "wf" });
    expect(s.created).toContain("acme__foo");
    const rec = store.getByKey("acme__foo")!;
    expect(rec.tier).toBe("candidate");
    expect(rec.supportedDtypes).toEqual(["fp8_e4m3fn"]);
    expect(rec.validation?.[0]).toMatchObject({ xpuUtilizationPct: 81, taskId: "t1" });
  });

  it("appends to an existing record without a structural overwrite (no 409)", async () => {
    process.env.XPU_CATALOG_ENABLED = "1";
    // First run creates + validates.
    writeArtifact([{ repository: "https://github.com/acme/Foo", nodeTypePrefixes: ["Foo"], evidence: { nodeType: "FooNode", workflowName: "wfA", passed: true, passedAt: "2026-08-18T01:00:00Z" } }]);
    await applyCatalogWriteBack(artifactDir, { taskId: "t1" });
    // Second run: a different workflow validates the same node.
    writeArtifact([{ repository: "https://github.com/acme/Foo", evidence: { nodeType: "FooNode", workflowName: "wfB", passed: true, passedAt: "2026-08-18T02:00:00Z" } }]);
    const s = await applyCatalogWriteBack(artifactDir, { taskId: "t2" });
    expect(s.created).toHaveLength(0); // already exists
    expect(s.validated).toContain("acme__foo");
    const rec = store.getByKey("acme__foo")!;
    expect(rec.validation).toHaveLength(2);
    // Two distinct passing workflows → auto-promoted to trusted.
    expect(rec.tier).toBe("trusted");
  });
});
