import { describe, expect, it } from "vitest";
import { substituteNodes, type GGraph, type GLink } from "./graphSubstitute";
import { loadSubstitutionRecipes, findSubstitutionRecipe } from "./substitutionRecipes";

const recipes = loadSubstitutionRecipes();
const gemini = findSubstitutionRecipe(recipes.recipes, "GeminiNode")!;

// Minimal GUI graph: LoadImage → GeminiNode.images, StringConcat → GeminiNode.prompt,
// GeminiNode.STRING → PreviewAny. audio/video/files unconnected.
function geminiGraph(): GGraph {
  return {
    last_node_id: 4,
    last_link_id: 12,
    nodes: [
      { id: 1, type: "LoadImage", outputs: [{ name: "IMAGE", type: "IMAGE", links: [10] }] },
      { id: 2, type: "StringConcatenate", outputs: [{ name: "STRING", type: "STRING", links: [11] }] },
      {
        id: 3,
        type: "GeminiNode",
        inputs: [
          { name: "images", type: "IMAGE", link: 10 },
          { name: "audio", type: "AUDIO", link: null },
          { name: "video", type: "VIDEO", link: null },
          { name: "files", type: "GEMINI_INPUT_FILES", link: null },
          { name: "prompt", type: "STRING", link: 11 }
        ],
        outputs: [{ name: "STRING", type: "STRING", links: [12] }],
        widgets_values: ["", "gemini-2.5-flash", "42", "randomize", "sys prompt"]
      },
      { id: 4, type: "PreviewAny", inputs: [{ name: "source", type: "*", link: 12 }] }
    ],
    links: [
      [10, 1, 0, 3, 0, "IMAGE"],
      [11, 2, 0, 3, 4, "STRING"],
      [12, 3, 0, 4, 0, "STRING"]
    ] as GLink[]
  };
}

describe("substituteNodes (GeminiNode → local VLM subgraph)", () => {
  it("replaces the API node with the 3-node local subgraph, remapping all links", () => {
    const before = geminiGraph();
    const { workflow, report } = substituteNodes(before, [{ apiNodeId: 3, recipe: gemini }]);
    const nodes = workflow.nodes!;
    const links = workflow.links as GLink[];

    // API node gone; the 3 local nodes present.
    expect(nodes.some((n) => n.type === "GeminiNode")).toBe(false);
    const vlm = nodes.find((n) => n.type === "llama_cpp_instruct_adv")!;
    expect(vlm).toBeTruthy();
    expect(nodes.some((n) => n.type === "llama_cpp_model_loader")).toBe(true);
    expect(nodes.some((n) => n.type === "llama_cpp_parameters")).toBe(true);

    const imagesSlot = vlm.inputs!.findIndex((i) => i.name === "images");
    const promptSlot = vlm.inputs!.findIndex((i) => i.name === "custom_prompt");

    // incoming image link now targets the VLM's images input
    const l10 = links.find((l) => l[0] === 10)!;
    expect(l10[3]).toBe(vlm.id);
    expect(l10[4]).toBe(imagesSlot);
    // incoming prompt link now targets the VLM's custom_prompt input
    const l11 = links.find((l) => l[0] === 11)!;
    expect(l11[3]).toBe(vlm.id);
    expect(l11[4]).toBe(promptSlot);
    // downstream STRING consumer now sourced from the VLM output slot 0
    const l12 = links.find((l) => l[0] === 12)!;
    expect(l12[1]).toBe(vlm.id);
    expect(l12[2]).toBe(0);

    // per-node input mirrors kept in sync
    expect(vlm.inputs![imagesSlot].link).toBe(10);
    expect(vlm.inputs![promptSlot].link).toBe(11);
    // llama_model + parameters internally linked (new links exist)
    const modelSlot = vlm.inputs!.findIndex((i) => i.name === "llama_model");
    const paramSlot = vlm.inputs!.findIndex((i) => i.name === "parameters");
    expect(vlm.inputs![modelSlot].link).toBeTypeOf("number");
    expect(vlm.inputs![paramSlot].link).toBeTypeOf("number");

    // report + integrity
    expect(report.isDag).toBe(true);
    expect(report.substituted).toHaveLength(1);
    expect(report.substituted[0].from).toBe("GeminiNode");
    expect(report.substituted[0].droppedInputs).toEqual(["audio", "video", "files"]);
    expect(report.warnings).toEqual([]);
    // id counters bumped past the inserted nodes/links
    expect(workflow.last_node_id!).toBeGreaterThanOrEqual(7);
    expect(workflow.last_link_id!).toBeGreaterThanOrEqual(14);
  });

  it("is a pure no-op with no plans, and does not mutate the input", () => {
    const before = geminiGraph();
    const snapshot = JSON.stringify(before);
    const { workflow, report } = substituteNodes(before, []);
    expect(JSON.stringify(before)).toBe(snapshot); // input untouched
    expect(report.substituted).toHaveLength(0);
    expect(workflow.nodes!.some((n) => n.type === "GeminiNode")).toBe(true);
  });
});
