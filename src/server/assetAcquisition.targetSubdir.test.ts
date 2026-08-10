import { describe, expect, it } from "vitest";
import { targetSubdir, type AssetRow } from "./assetAcquisition";

function row(partial: Partial<AssetRow>): AssetRow {
  return {
    asset_name: "",
    requested_name: "",
    resolved_path: "",
    source: "",
    state: "",
    staged_path: "",
    custom_node_repo: "",
    custom_node_cache_path: "",
    wrapper_source_evidence: "",
    commit: "",
    install_status: "",
    acquisition_status: "",
    mirror_used: "",
    credential_recorded: "",
    gap: "",
    ...partial
  };
}

describe("targetSubdir — LLM/VLM routing for known custom nodes", () => {
  it("routes a llama_cpp_model_loader GGUF to models/LLM (not text_encoders, despite the 'qwen' name)", () => {
    expect(
      targetSubdir(
        row({
          requested_name: "Qwen3.5-27B-heretic.Q4_K_M.gguf",
          wrapper_source_evidence: "12:llama_cpp_model_loader"
        })
      )
    ).toBe("LLM");
  });

  it("routes the mmproj GGUF to models/LLM as well", () => {
    expect(
      targetSubdir(
        row({
          requested_name: "Qwen3.5-27B-heretic.mmproj-Q8_0.gguf",
          wrapper_source_evidence: "12:llama_cpp_model_loader"
        })
      )
    ).toBe("LLM");
  });

  it("regression: a real qwen text encoder (no llama_cpp evidence) still routes to text_encoders", () => {
    expect(
      targetSubdir(
        row({
          requested_name: "qwen2.5-vl-7b-instruct.safetensors",
          wrapper_source_evidence: "5:CLIPLoader"
        })
      )
    ).toBe("text_encoders");
  });
});
