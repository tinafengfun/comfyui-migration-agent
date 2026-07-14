import { describe, expect, it } from "vitest";
import { normalizeWorkflowForApi, type WorkflowGraph } from "./workflowNormalize";

// Build a workflow with a transform-loop cycle (the WF2 pattern):
//   17 VAEDecode -> 41 SeedVR2VideoUpscaler -> 43 SaveImage
//   41 -> 35 ImageScaleToTotalPixels -> 36 PreviewImage
//   AND the erroneous back-edge: 35 -> 41 (IMAGE)  [creates 41<->35 cycle]
// SeedVR2(41) has external model inputs (38/39) → it's the transform.
function cycleWorkflow(): WorkflowGraph {
  // link tuple: [link_id, src_node, src_slot, dst_node, dst_slot, type]
  const links: WorkflowGraph["links"] = [
    [53, 35, 0, 41, 0, "IMAGE"], // back-edge (should be cut + rewired to 17)
    [54, 38, 0, 41, 0, "SEEDVR2_DIT"],
    [55, 39, 0, 41, 0, "SEEDVR2_VAE"],
    [58, 41, 0, 43, 0, "IMAGE"], // 41 -> SaveImage
    [61, 41, 0, 35, 0, "IMAGE"], // 41 -> 35 (forward, keep)
    [52, 35, 0, 36, 0, "IMAGE"], // 35 -> PreviewImage
    [59, 17, 0, 42, 0, "IMAGE"] // VAEDecode -> Comparer (makes 17 the primary producer feeding a sink)
  ] as WorkflowGraph["links"];
  return {
    nodes: [
      { id: 17, type: "VAEDecode" },
      { id: 35, type: "ImageScaleToTotalPixels" },
      { id: 36, type: "PreviewImage" },
      { id: 38, type: "SeedVR2LoadDiTModel" },
      { id: 39, type: "SeedVR2LoadVAEModel" },
      { id: 41, type: "SeedVR2VideoUpscaler" },
      { id: 42, type: "Image Comparer (rgthree)" },
      { id: 43, type: "SaveImage" }
    ],
    links
  };
}

describe("normalizeWorkflowForApi", () => {
  it("cuts the transform-loop back-edge and rewires to the image producer (coverage parity)", () => {
    const { workflow, report } = normalizeWorkflowForApi(cycleWorkflow());
    expect(report.changed).toBe(true);
    expect(report.cyclesFound).toBe(1);
    expect(report.isDag).toBe(true);
    // every active node still executes
    expect(report.coverage.execute).toBe(report.coverage.active);
    expect(report.coverage.active).toBe(8);
    // the back-edge link 53 was rewired: source 35 -> 17 (VAEDecode)
    const link53 = (workflow.links as unknown[][]).find((l) => l[0] === 53)!;
    expect(link53[1]).toBe(17); // now sourced from VAEDecode
    expect(link53[3]).toBe(41); // still feeds SeedVR2's image input
    // the forward edge link 61 (41->35) is preserved
    const link61 = (workflow.links as unknown[][]).find((l) => l[0] === 61)!;
    expect(link61[1]).toBe(41);
    expect(link61[3]).toBe(35);
    // primary producer detected as VAEDecode(17)
    expect(report.primaryImageProducer).toBe(17);
    expect(report.changes[0].transform).toBe("SeedVR2VideoUpscaler");
  });

  it("is a no-op on an already-DAG workflow", () => {
    const wf = cycleWorkflow();
    // break the cycle manually before normalizing
    (wf.links as unknown[][]).find((l) => l[0] === 53)![1] = 17;
    const { report } = normalizeWorkflowForApi(wf);
    expect(report.changed).toBe(false);
    expect(report.cyclesFound).toBe(0);
    expect(report.isDag).toBe(true);
  });

  it("does not mutate the input workflow", () => {
    const wf = cycleWorkflow();
    const original = JSON.parse(JSON.stringify(wf));
    normalizeWorkflowForApi(wf);
    expect(wf).toEqual(original);
  });
});
