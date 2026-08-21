import { describe, expect, it } from "vitest";
import { freshValidatedNodeIds, freshValidatedNodeTypes } from "./catalogBranchHarvest";

const GRAPH = {
  "3": { class_type: "BerniniConditioning" },
  "7": { class_type: "VAELoader" },
  "9": { class_type: "CLIPLoader" },
  "16": { class_type: "VAEDecode" }
};

// Branch A: passed, freshly executed 16 (VAEDecode) + 3; 7 was cached.
// Branch B: failed — its executed nodes must NOT count.
// Branch C: cache_assisted_pass, freshly executed 9 (CLIPLoader).
const SUMMARY = {
  branch_summaries: [
    { status: "passed", history_summary: { executed_nodes: ["16", "3"], cached_nodes: ["7"] } },
    { status: "failed_runtime", history_summary: { executed_nodes: ["9", "99"], cached_nodes: [] } },
    { status: "cache_assisted_pass", history_summary: { executed_nodes: ["9"], cached_nodes: ["3"] } }
  ]
};

describe("catalog branch harvest (option B)", () => {
  it("collects only node IDs executed fresh on a SUCCESSFUL branch", () => {
    const ids = freshValidatedNodeIds(SUMMARY);
    expect([...ids].sort()).toEqual(["16", "3", "9"]); // 7 cached-only, 99 from a FAILED branch → excluded
  });

  it("maps fresh IDs to class_types via the graph", () => {
    const types = freshValidatedNodeTypes(SUMMARY, GRAPH);
    expect(types).toEqual(new Set(["VAEDecode", "BerniniConditioning", "CLIPLoader"]));
    expect(types.has("VAELoader")).toBe(false); // node 7 only cached → not fresh-validated
  });

  it("a node on ONLY a failed branch is not validated", () => {
    const onlyFailed = { branch_summaries: [{ status: "failed_runtime", history_summary: { executed_nodes: ["16"] } }] };
    expect(freshValidatedNodeTypes(onlyFailed, GRAPH).size).toBe(0);
  });

  it("empty/absent summary → empty set", () => {
    expect(freshValidatedNodeTypes({}, GRAPH).size).toBe(0);
    expect(freshValidatedNodeIds({ branch_summaries: [] }).size).toBe(0);
  });
});
