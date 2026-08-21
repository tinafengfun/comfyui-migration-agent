import { describe, expect, it } from "vitest";
import { branchValidatedNodeTypes, subgraphIds } from "./catalogBranchHarvest";

// A workflow: SaveImage(16) ← VAEDecode(15) ← {VAELoader(7), Sampler(14) ← UNet(5)};
// PreviewAny(52) ← BarNode(8). Two output branches: node-16 and node-52.
const GRAPH = {
  "5": { class_type: "UNETLoader", inputs: {} },
  "7": { class_type: "VAELoader", inputs: {} },
  "14": { class_type: "SamplerCustom", inputs: { model: ["5", 0] } },
  "15": { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["7", 0] } },
  "16": { class_type: "SaveImage", inputs: { images: ["15", 0] } },
  "8": { class_type: "BarNode", inputs: {} },
  "52": { class_type: "PreviewAny", inputs: { x: ["8", 0] } }
};

describe("subgraphIds", () => {
  it("collects the target + transitive upstream", () => {
    expect(subgraphIds(GRAPH, "16")).toEqual(new Set(["16", "15", "14", "7", "5"]));
    expect(subgraphIds(GRAPH, "52")).toEqual(new Set(["52", "8"]));
  });
});

describe("branchValidatedNodeTypes (option B, graph-based)", () => {
  it("records node types on a SUCCESSFUL branch's path (both branches passed)", () => {
    const summary = {
      branch_summaries: [
        { branch: "node-16", status: "passed" },
        { branch: "node-52", status: "cache_assisted_pass" }
      ]
    };
    expect(branchValidatedNodeTypes(summary, GRAPH)).toEqual(
      new Set(["SaveImage", "VAEDecode", "SamplerCustom", "VAELoader", "UNETLoader", "PreviewAny", "BarNode"])
    );
  });

  it("excludes nodes only on a FAILED branch (the DB-entry gate)", () => {
    const summary = {
      branch_summaries: [
        { branch: "node-16", status: "passed" }, // path: 16,15,14,7,5
        { branch: "node-52", status: "failed_runtime" } // BarNode(8)/PreviewAny(52) NOT validated
      ]
    };
    const types = branchValidatedNodeTypes(summary, GRAPH);
    expect(types.has("VAEDecode")).toBe(true);
    expect(types.has("BarNode")).toBe(false);
    expect(types.has("PreviewAny")).toBe(false);
  });

  it("empty when no branch succeeded / summary missing", () => {
    expect(branchValidatedNodeTypes({ branch_summaries: [{ branch: "node-16", status: "failed_runtime" }] }, GRAPH).size).toBe(0);
    expect(branchValidatedNodeTypes({}, GRAPH).size).toBe(0);
  });
});
