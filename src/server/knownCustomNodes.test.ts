import { describe, expect, it } from "vitest";
import {
  KNOWN_CUSTOM_NODES,
  knownCustomNodeForType,
  knownCustomNodeForEvidence
} from "./knownCustomNodes";

describe("knownCustomNodes registry", () => {
  it("resolves every llama_cpp_* node type to ComfyUI-llama-cpp_vlm by prefix", () => {
    for (const type of ["llama_cpp_model_loader", "llama_cpp_parameters", "llama_cpp_instruct_adv"]) {
      const known = knownCustomNodeForType(type);
      expect(known?.packageName).toBe("ComfyUI-llama-cpp_vlm");
      expect(known?.repository).toBe("https://github.com/lihaoyun6/ComfyUI-llama-cpp_vlm");
      expect(known?.modelSubdir).toBe("LLM");
    }
  });

  it("matches by prefix so a future llama_cpp_* node is covered too", () => {
    expect(knownCustomNodeForType("llama_cpp_some_new_node")?.packageName).toBe("ComfyUI-llama-cpp_vlm");
  });

  it("resolves every VHS_* node type to ComfyUI-VideoHelperSuite by prefix", () => {
    for (const type of ["VHS_LoadVideo", "VHS_VideoCombine", "VHS_VideoInfo"]) {
      const known = knownCustomNodeForType(type);
      expect(known?.packageName).toBe("ComfyUI-VideoHelperSuite");
      expect(known?.repository).toBe("https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite");
    }
  });

  it("returns undefined for unrelated / empty node types", () => {
    expect(knownCustomNodeForType("KSampler")).toBeUndefined();
    expect(knownCustomNodeForType("CLIPLoader")).toBeUndefined();
    expect(knownCustomNodeForType("")).toBeUndefined();
  });

  it("resolves by asset evidence (loader class in wrapper_source_evidence), case-insensitively", () => {
    expect(knownCustomNodeForEvidence("1:llama_cpp_model_loader")?.modelSubdir).toBe("LLM");
    expect(knownCustomNodeForEvidence("LLAMA_CPP_MODEL_LOADER")?.packageName).toBe("ComfyUI-llama-cpp_vlm");
    expect(knownCustomNodeForEvidence("3:UNETLoader")).toBeUndefined();
    expect(knownCustomNodeForEvidence("")).toBeUndefined();
  });

  it("marks the CUDA requirements.txt as skip and the backend as cpu", () => {
    const llama = KNOWN_CUSTOM_NODES.find((n) => n.packageName === "ComfyUI-llama-cpp_vlm");
    expect(llama?.pip?.backend).toBe("cpu");
    expect(llama?.pip?.skipRequirementsTxt).toBe(true);
  });
});
