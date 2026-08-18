import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "./store";
import { GitRepo } from "./gitRepo";
import { CatalogWriter } from "./writer";
import { createCatalogApp } from "./server";
import type { XpuNodeRecord } from "./schema";

let root: string;
let store: CatalogStore;
let server: Server;
let base: string;

function rec(nodeKey: string, over: Partial<XpuNodeRecord> = {}): XpuNodeRecord {
  return {
    schemaVersion: 1, nodeKey, packageName: nodeKey.split("__")[1],
    repository: `https://github.com/${nodeKey.replace("__", "/")}`,
    nodeTypePrefixes: [nodeKey.split("__")[1]], execution: "xpu", xpuSupport: "patched",
    tier: "candidate", version: 1, createdAt: "2026-08-18T00:00:00Z", updatedAt: "2026-08-18T00:00:00Z", ...over
  };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xpu-catalog-http-"));
  fs.mkdirSync(path.join(root, "nodes"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  process.env.XPU_CATALOG_DB = path.join(root, "catalog.sqlite");
  store = new CatalogStore(root);
  const writer = new CatalogWriter({ store, git: new GitRepo(root, { branch: "main" }), promoteThreshold: 2 });
  await new Promise<void>((resolve) => {
    server = createCatalogApp(store, writer).listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  delete process.env.XPU_CATALOG_DB;
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (p: string, body: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("catalog-server write routes", () => {
  it("POST /nodes upserts, GET /resolve reads it back", async () => {
    const up = await post("/api/xpu-catalog/nodes", rec("owner__pkg"));
    expect(up.status).toBe(200);
    const r = await (await fetch(`${base}/api/xpu-catalog/resolve?nodeType=pkg`)).json();
    expect(r.found).toBe(true);
    expect(r.record.nodeKey).toBe("owner__pkg");
  });

  it("stale upsert returns HTTP 409", async () => {
    await post("/api/xpu-catalog/nodes", rec("owner__pkg"));
    const stale = await post("/api/xpu-catalog/nodes", rec("owner__pkg", { version: 1, xpuSupport: "native" }));
    // first write made it v1; passing version 1 again is fine once...
    expect(stale.status).toBe(200);
    const staleAgain = await post("/api/xpu-catalog/nodes", rec("owner__pkg", { version: 1 }));
    expect(staleAgain.status).toBe(409);
  });

  it("validation append + auto-promotion over HTTP", async () => {
    await post("/api/xpu-catalog/nodes", rec("owner__pkg"));
    await post("/api/xpu-catalog/nodes/owner__pkg/validation", {
      evidence: { taskId: "t1", workflowName: "wfA", passed: true, passedAt: "2026-08-18T01:00:00Z" }
    });
    await post("/api/xpu-catalog/nodes/owner__pkg/validation", {
      evidence: { taskId: "t2", workflowName: "wfB", passed: true, passedAt: "2026-08-18T02:00:00Z" }
    });
    const rec2 = await (await fetch(`${base}/api/xpu-catalog/nodes/owner__pkg`)).json();
    expect(rec2.tier).toBe("trusted");
  });

  it("lease: first holder 200, second holder 409 with holder info", async () => {
    await post("/api/xpu-catalog/nodes", rec("owner__pkg"));
    const a = await post("/api/xpu-catalog/nodes/owner__pkg/lease", { holder: "agentA", ttlSec: 600 });
    expect(a.status).toBe(200);
    const b = await post("/api/xpu-catalog/nodes/owner__pkg/lease", { holder: "agentB", ttlSec: 600 });
    expect(b.status).toBe(409);
    expect((await b.json()).holder).toBe("agentA");
  });
});
