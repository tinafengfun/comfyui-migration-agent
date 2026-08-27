import { describe, expect, it } from "vitest";
import { buildSeedRecords } from "./seedImport";
import { validateXpuNode, nodeKeyFromRepo } from "./schema";
import { resetSchemaCache } from "../server/schemaValidate";

describe("xpu-catalog seed import", () => {
  const NOW = "2026-08-18T00:00:00Z";

  it("every seeded record validates against xpu-node.schema.json", () => {
    resetSchemaCache();
    const records = buildSeedRecords(NOW);
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      const r = validateXpuNode(rec);
      expect(r.ok, `record ${rec.nodeKey} invalid: ${r.ok ? "" : r.message}`).toBe(true);
    }
  });

  it("merges the llama_cpp recipe + knownCustomNodes entry into ONE package record with repo + nfsPath", () => {
    const records = buildSeedRecords(NOW);
    const key = nodeKeyFromRepo("https://github.com/lihaoyun6/ComfyUI-llama-cpp_vlm");
    const llama = records.filter((r) => r.nodeKey === key);
    expect(llama.length, "known + recipe must merge into a single record").toBe(1);
    const rec = llama[0];
    // GitHub link is stored...
    expect(rec.repository).toContain("github.com/lihaoyun6/ComfyUI-llama-cpp_vlm");
    // ...and the local /nfs_share path is stored.
    expect(rec.nfsPath).toBe("/nfs_share/custom_nodes/ComfyUI-llama-cpp_vlm");
    expect(rec.onNfsShare).toBe(true);
    // The SYCL wheel is now wired in (pip.backend "xpu" from knownCustomNodes), but the node
    // still defaults to CPU execution (from the recipe) — it offloads to XPU only when a
    // workflow sets n_gpu_layers>0. See knownCustomNodes note + memory llama_cpp_vlm_node.
    expect(rec.execution).toBe("cpu");
    expect(rec.pip?.backend).toBe("xpu");
    expect(rec.nodeTypePrefixes).toContain("llama_cpp_");
    expect(rec.tier).toBe("trusted");
  });

  it("carries recipe XPU knowledge (patches, knownIssues, enum values) into records", () => {
    const records = buildSeedRecords(NOW);
    // The fp8 keep-on-move recipe → a patch entry.
    const withPatch = records.find((r) => (r.patches ?? []).some((p) => p.file.includes("xpu-fp8-keep-quantized-on-move")));
    expect(withPatch, "the fp8 keep-on-move patch should seed into a record").toBeTruthy();
    // RES4LYF enum values.
    const withEnum = records.find((r) => (r.providesEnumValues ?? []).length > 0);
    expect(withEnum, "an enum-providing package (RES4LYF) should seed").toBeTruthy();
  });

  it("all nodeKeys are unique and schema-pattern valid", () => {
    const records = buildSeedRecords(NOW);
    const keys = records.map((r) => r.nodeKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9][a-z0-9._-]*__[a-z0-9][a-z0-9._-]*$/);
  });
});
