/**
 * catalog-server — the single writer/coordinator for the XPU-support catalog.
 *
 * Runs on the NFS home node (172.16.124.12). Every agent on every node is an
 * HTTP client (xpuCatalogClient.ts). This file is the read path (P1); the write
 * path (upsert / validation / promote / lease) is added in P2 on the same app +
 * store. `createCatalogApp(store)` is exported for tests; `main()` boots it.
 */
import express from "express";
import { CatalogStore, defaultCatalogDataDir } from "./store";
import type { CatalogTier } from "./schema";

export function createCatalogApp(store: CatalogStore): express.Express {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, records: store.count(), dataDir: store.dataDir });
  });

  // The agent lookup: resolve by nodeType (class_type prefix) or by repo URL.
  app.get("/api/xpu-catalog/resolve", (req, res) => {
    const nodeType = typeof req.query.nodeType === "string" ? req.query.nodeType : undefined;
    const repo = typeof req.query.repo === "string" ? req.query.repo : undefined;
    if (!nodeType && !repo) {
      res.status(400).json({ error: "provide nodeType or repo" });
      return;
    }
    const result = nodeType ? store.resolveByNodeType(nodeType) : store.resolveByRepo(repo!);
    if (!result) {
      res.status(404).json({ found: false });
      return;
    }
    res.json({ found: true, ...result });
  });

  app.get("/api/xpu-catalog/nodes", (req, res) => {
    const tier = typeof req.query.tier === "string" ? (req.query.tier as CatalogTier) : undefined;
    const xpuSupport = typeof req.query.xpuSupport === "string" ? req.query.xpuSupport : undefined;
    const nodeType = typeof req.query.nodeType === "string" ? req.query.nodeType : undefined;
    res.json({ nodes: store.list({ tier, xpuSupport, nodeType }) });
  });

  app.get("/api/xpu-catalog/nodes/:key", (req, res) => {
    const rec = store.getByKey(req.params.key);
    if (!rec) {
      res.status(404).json({ found: false });
      return;
    }
    res.json(rec);
  });

  return app;
}

/** Boot: open the store, rebuild the index from the working-clone JSON, listen. */
export function main(): void {
  const dataDir = defaultCatalogDataDir();
  const store = new CatalogStore(dataDir);
  const indexed = store.rebuildFromJson();
  const port = Number(process.env.XPU_CATALOG_PORT ?? 3100);
  const app = createCatalogApp(store);
  app.listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`[catalog-server] listening on :${port} — ${indexed} records indexed from ${store.nodesDir}`);
  });
}

// Boot when run directly (tsx src/catalog/server.ts), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
