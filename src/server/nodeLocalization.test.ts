import { describe, expect, it } from "vitest";
import { planNodeLocalization } from "./nodeLocalization";
import type { GGraph } from "./graphSubstitute";

describe("planNodeLocalization (handler registry)", () => {
  it("detects a GeminiNode and proposes the local-VLM substitution", () => {
    const graph: GGraph = {
      nodes: [
        { id: 1, type: "LoadImage" },
        { id: 3, type: "GeminiNode", inputs: [{ name: "images", link: null }], outputs: [{ name: "STRING", links: [] }] }
      ],
      links: []
    };
    const { plans, proposals } = planNodeLocalization(graph);
    expect(plans).toHaveLength(1);
    expect(plans[0].apiNodeId).toBe(3);
    expect(proposals[0].from).toBe("GeminiNode");
    expect(proposals[0].handlerId).toBe("api-substitution");
    expect(proposals[0].toNodes).toContain("llama_cpp_instruct_adv");
    expect(proposals[0].droppedInputs).toEqual(["audio", "video", "files"]);
  });

  it("fast-passes (no plans) on a graph with no API node", () => {
    const graph: GGraph = { nodes: [{ id: 1, type: "KSampler" }, { id: 2, type: "VAEDecode" }], links: [] };
    const { plans, proposals } = planNodeLocalization(graph);
    expect(plans).toHaveLength(0);
    expect(proposals).toHaveLength(0);
  });
});
