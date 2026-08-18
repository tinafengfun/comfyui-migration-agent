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
import { GitRepo } from "./gitRepo";
import { CatalogWriter } from "./writer";
import type { CatalogTier, XpuNodeRecord } from "./schema";

/** Await a writer op and map its typed error `.code` to an HTTP status. */
async function handle(res: express.Response, fn: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await fn());
  } catch (e) {
    const code = (e as { code?: number }).code ?? 500;
    res.status(code).json({ error: (e as Error).message });
  }
}

export function createCatalogApp(store: CatalogStore, writer?: CatalogWriter): express.Express {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, records: store.count(), dataDir: store.dataDir, writable: Boolean(writer) });
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

  // ── Write routes (only when a writer is provided) ─────────────────────────
  if (writer) {
    app.post("/api/xpu-catalog/nodes", (req, res) =>
      handle(res, () => writer.upsert(req.body as XpuNodeRecord))
    );

    app.post("/api/xpu-catalog/nodes/:key/validation", (req, res) => {
      const body = req.body as {
        evidence: Parameters<CatalogWriter["appendValidation"]>[1];
        backfillRepository?: string;
        backfillNfsPath?: string;
      };
      return handle(res, () =>
        writer.appendValidation(req.params.key, body.evidence, {
          backfillRepository: body.backfillRepository,
          backfillNfsPath: body.backfillNfsPath
        })
      );
    });

    app.post("/api/xpu-catalog/nodes/:key/promote", (req, res) =>
      handle(res, () => writer.promote(req.params.key, (req.body?.by as string) ?? "human"))
    );

    app.post("/api/xpu-catalog/nodes/:key/retire", (req, res) =>
      handle(res, () => writer.retire(req.params.key, (req.body?.reason as string) ?? "retired"))
    );

    // Migration lease: granted → 200; held by another agent → 409 (client waits + reuses).
    app.post("/api/xpu-catalog/nodes/:key/lease", async (req, res) => {
      const holder = (req.body?.holder as string) ?? "unknown";
      const ttlSec = Number(req.body?.ttlSec ?? 600);
      try {
        const grant = await writer.acquireLease(req.params.key, holder, ttlSec);
        res.status(grant.granted ? 200 : 409).json(grant);
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    });

    app.post("/api/xpu-catalog/nodes/:key/lease/heartbeat", (req, res) =>
      handle(res, async () => ({
        ok: await writer.heartbeatLease(req.params.key, req.body?.leaseId as string, Number(req.body?.ttlSec ?? 600))
      }))
    );

    app.delete("/api/xpu-catalog/nodes/:key/lease", (req, res) =>
      handle(res, async () => ({ released: await writer.releaseLease(req.params.key, req.body?.leaseId as string) }))
    );
  }

  return app;
}

/** Boot: open the store, rebuild the index from the working-clone JSON, listen. */
export function main(): void {
  const dataDir = defaultCatalogDataDir();
  const store = new CatalogStore(dataDir);
  const git = new GitRepo(dataDir, {
    remote: process.env.XPU_CATALOG_REMOTE,
    branch: process.env.XPU_CATALOG_BRANCH ?? "main"
  });
  const writer = new CatalogWriter({ store, git });
  const indexed = store.rebuildFromJson();
  const port = Number(process.env.XPU_CATALOG_PORT ?? 3100);
  const app = createCatalogApp(store, writer);
  app.listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`[catalog-server] listening on :${port} — ${indexed} records indexed from ${store.nodesDir}`);
  });
}

// Boot when run directly (tsx src/catalog/server.ts), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
