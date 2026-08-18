import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../catalog/store";
import { createCatalogApp } from "../catalog/server";
import { writeSeedRecords, buildSeedRecords } from "../catalog/seedImport";
import { resolveNodeType, resolveRepo } from "./xpuCatalogClient";

let dir: string;
let store: CatalogStore;
let server: Server | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpu-catalog-client-"));
  process.env.XPU_CATALOG_DB = path.join(dir, "catalog.sqlite");
  process.env.XPU_CATALOG_DATA_DIR = dir;
  writeSeedRecords(path.join(dir, "nodes"), buildSeedRecords("2026-08-18T00:00:00Z"));
  store = new CatalogStore(dir);
  store.rebuildFromJson();
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  store.close();
  delete process.env.XPU_CATALOG_DB;
  delete process.env.XPU_CATALOG_DATA_DIR;
  delete process.env.XPU_CATALOG_SERVER_URL;
  fs.rmSync(dir, { recursive: true, force: true });
});

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createCatalogApp(store).listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      process.env.XPU_CATALOG_SERVER_URL = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

describe("xpuCatalogClient", () => {
  it("resolves via the server when reachable (source=server)", async () => {
    await startServer();
    const r = await resolveNodeType("llama_cpp_parameters");
    expect(r?.source).toBe("server");
    expect(r?.record.nodeKey).toBe("lihaoyun6__comfyui-llama-cpp_vlm");
  });

  it("resolves by repo via the server", async () => {
    await startServer();
    const r = await resolveRepo("https://github.com/lihaoyun6/ComfyUI-llama-cpp_vlm");
    expect(r?.source).toBe("server");
    expect(r?.record.execution).toBe("cpu");
  });

  it("falls back to /nfs_share working-clone JSON when the server is unreachable", async () => {
    // No server started; point at a dead port so fetch fails fast.
    process.env.XPU_CATALOG_SERVER_URL = "http://127.0.0.1:1"; // unroutable
    const r = await resolveNodeType("llama_cpp_model_loader");
    expect(r?.source).toBe("fallback");
    expect(r?.record.nodeKey).toBe("lihaoyun6__comfyui-llama-cpp_vlm");
  });

  it("returns null (clean miss) from the server for an unknown node, without falling back", async () => {
    await startServer();
    const r = await resolveNodeType("TotallyUnknownCoreNode");
    expect(r).toBeNull();
  });
});
