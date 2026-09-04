import { describe, expect, it } from "vitest";
import {
  parseVlmVerdict,
  buildJudgeGraph,
  extractVlmConfigFromGraph,
  DEFAULT_JUDGE_PROMPT,
  type VlmNodeConfig,
} from "./vlmJudge";

const VLM: VlmNodeConfig = {
  loader: { class_type: "llama_cpp_model_loader", inputs: { model: "Qwen.gguf", mmproj: "mm.gguf" } },
  params: { class_type: "llama_cpp_parameters", inputs: { max_tokens: 256 } },
  instruct: {
    class_type: "llama_cpp_instruct_adv",
    inputs: { llama_model: ["9", 0], parameters: ["8", 0], images: ["7", 0], custom_prompt: "old", system_prompt: "old-sys" },
  },
};

describe("parseVlmVerdict (fail-closed)", () => {
  it("passes only on an explicit leading PASS with no FAIL", () => {
    const v = parseVlmVerdict("PASS\nHigh-quality, detailed render of a red apple.");
    expect(v.pass).toBe(true);
    expect(v.reason).toMatch(/apple/i);
  });
  it("fails on FAIL", () => {
    const v = parseVlmVerdict("FAIL\nUniform muddy brown, no content.");
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/muddy|content/i);
  });
  it("fail-closed when both words appear or the reply is empty/garbled", () => {
    expect(parseVlmVerdict("It might PASS but actually FAIL").pass).toBe(false);
    expect(parseVlmVerdict("").pass).toBe(false);
    expect(parseVlmVerdict("hmm not sure").pass).toBe(false);
  });
});

describe("buildJudgeGraph", () => {
  it("wires the VLM subgraph to a LoadImage + judge prompt and captures text via PreviewAny", () => {
    const g = buildJudgeGraph(VLM, "render.png");
    const load = Object.values(g).find((n: any) => n.class_type === "LoadImage") as any;
    const vlm = Object.values(g).find((n: any) => n.class_type === "llama_cpp_instruct_adv") as any;
    const loader = Object.entries(g).find(([, n]: any) => n.class_type === "llama_cpp_model_loader")![0];
    const params = Object.entries(g).find(([, n]: any) => n.class_type === "llama_cpp_parameters")![0];
    const out = Object.values(g).find((n: any) => n.class_type === "PreviewAny") as any;

    expect(load.inputs.image).toBe("render.png");
    // images now come from the LoadImage node, not the original wiring
    expect(vlm.inputs.images[0]).toBe(Object.entries(g).find(([, n]: any) => n.class_type === "LoadImage")![0]);
    expect(vlm.inputs.llama_model[0]).toBe(loader);
    expect(vlm.inputs.parameters[0]).toBe(params);
    expect(vlm.inputs.custom_prompt).toBe(DEFAULT_JUDGE_PROMPT);
    expect(vlm.inputs.system_prompt).toMatch(/PASS or FAIL/);
    // PreviewAny reads the VLM output
    const vlmId = Object.entries(g).find(([, n]: any) => n.class_type === "llama_cpp_instruct_adv")![0];
    expect(out.inputs.source[0]).toBe(vlmId);
  });
});

describe("extractVlmConfigFromGraph", () => {
  it("pulls the loader/params/instruct triple out of a localized workflow", () => {
    const prompt = {
      "3": { class_type: "llama_cpp_model_loader", inputs: { model: "Q.gguf" } },
      "4": { class_type: "llama_cpp_parameters", inputs: { max_tokens: 128 } },
      "5": { class_type: "llama_cpp_instruct_adv", inputs: { images: ["1", 0] } },
      "6": { class_type: "VAEDecode", inputs: {} },
    };
    const cfg = extractVlmConfigFromGraph(prompt)!;
    expect(cfg.loader.inputs.model).toBe("Q.gguf");
    expect(cfg.instruct.class_type).toBe("llama_cpp_instruct_adv");
  });
  it("returns null when the graph has no local VLM", () => {
    expect(extractVlmConfigFromGraph({ "1": { class_type: "GeminiNode", inputs: {} } })).toBeNull();
  });
});
