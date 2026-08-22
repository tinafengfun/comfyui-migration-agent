import { describe, expect, it } from "vitest";
import { branchValidatedNodeTypes, mainSmokeValidatedNodeTypes, subgraphIds } from "./catalogBranchHarvest";

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

// A single-output workflow: LoadImage(200) -> llama loader/params/instruct -> PreviewAny(52).
const MAIN_GRAPH = {
  "200": { class_type: "LoadImage", inputs: {} },
  "93": { class_type: "llama_cpp_model_loader", inputs: {} },
  "94": { class_type: "llama_cpp_parameters", inputs: {} },
  "92": { class_type: "llama_cpp_instruct_adv", inputs: { images: ["200", 0], llama_model: ["93", 0], parameters: ["94", 0] } },
  "52": { class_type: "PreviewAny", inputs: { source: ["92", 0] } }
};

describe("mainSmokeValidatedNodeTypes (single-output main smoke)", () => {
  const ALL = new Set(["LoadImage", "llama_cpp_model_loader", "llama_cpp_parameters", "llama_cpp_instruct_adv", "PreviewAny"]);

  it("validates the WHOLE graph when classification is pass (output_files null/absent)", () => {
    // The real, brittle case: agent wrote classification:"pass" but output_files:null.
    expect(mainSmokeValidatedNodeTypes({ classification: "pass", output_files: null }, MAIN_GRAPH)).toEqual(ALL);
    expect(mainSmokeValidatedNodeTypes({ classification: "PASS" }, MAIN_GRAPH)).toEqual(ALL);
  });

  it("also passes on non-empty output_files (fallback signal)", () => {
    expect(mainSmokeValidatedNodeTypes({ output_files: [{ node_id: "52" } as never] }, MAIN_GRAPH)).toEqual(ALL);
  });

  it("records NOTHING when the smoke did not pass", () => {
    expect(mainSmokeValidatedNodeTypes({ classification: "fail", output_files: [] }, MAIN_GRAPH).size).toBe(0);
    expect(mainSmokeValidatedNodeTypes({}, MAIN_GRAPH).size).toBe(0);
  });
});
