import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "./store";
import { writeSeedRecords, buildSeedRecords } from "./seedImport";

let dir: string;
let store: CatalogStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpu-catalog-store-"));
  process.env.XPU_CATALOG_DB = path.join(dir, "catalog.sqlite");
  writeSeedRecords(path.join(dir, "nodes"), buildSeedRecords("2026-08-18T00:00:00Z"));
  store = new CatalogStore(dir);
  store.rebuildFromJson();
});

afterEach(() => {
  store.close();
  delete process.env.XPU_CATALOG_DB;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CatalogStore", () => {
  it("rebuilds the index from the working-clone JSON", () => {
    // Count tracks the seed set (recipes ∪ KNOWN_CUSTOM_NODES) rather than a
    // hardcoded number, so adding a registry entry (e.g. VHS) doesn't false-fail this.
    expect(store.count()).toBe(buildSeedRecords("2026-08-18T00:00:00Z").length);
  });

  it("resolves by nodeType via class_type prefix (llama_cpp_* → the VLM package)", () => {
    const r = store.resolveByNodeType("llama_cpp_model_loader");
    expect(r?.record.nodeKey).toBe("lihaoyun6__comfyui-llama-cpp_vlm");
    expect(r?.matchedPrefix).toBe("llama_cpp_");
    expect(r?.record.repository).toContain("github.com");
    expect(r?.record.nfsPath).toBe("/nfs_share/custom_nodes/ComfyUI-llama-cpp_vlm");
  });

  it("resolves by repo URL", () => {
    const r = store.resolveByRepo("https://github.com/lihaoyun6/ComfyUI-llama-cpp_vlm.git");
    expect(r?.record.nodeKey).toBe("lihaoyun6__comfyui-llama-cpp_vlm");
  });

  it("prefers the more specific (longest) prefix / higher tier on overlap", () => {
    // Two records both matching 'foo_bar_node': a short candidate prefix and a longer trusted one.
    store.indexRecord({
      schemaVersion: 1, nodeKey: "o__short", packageName: "short", repository: "https://x/o/short",
      nodeTypePrefixes: ["foo_"], execution: "xpu", xpuSupport: "unknown", tier: "candidate",
      version: 1, createdAt: "2026-08-18T00:00:00Z", updatedAt: "2026-08-18T00:00:00Z"
    });
    store.indexRecord({
      schemaVersion: 1, nodeKey: "o__long", packageName: "long", repository: "https://x/o/long",
      nodeTypePrefixes: ["foo_bar_"], execution: "xpu", xpuSupport: "native", tier: "trusted",
      version: 1, createdAt: "2026-08-18T00:00:00Z", updatedAt: "2026-08-18T00:00:00Z"
    });
    const r = store.resolveByNodeType("foo_bar_node");
    expect(r?.record.nodeKey).toBe("o__long");
  });

  it("returns undefined for an unknown nodeType", () => {
    expect(store.resolveByNodeType("SomeCoreNodeNeverSeen")).toBeUndefined();
  });

  it("filters list() by tier", () => {
    const trusted = store.list({ tier: "trusted" });
    expect(trusted.length).toBeGreaterThan(0);
    expect(trusted.every((r) => r.tier === "trusted")).toBe(true);
  });
});
