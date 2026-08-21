import { describe, expect, it } from "vitest";
import {
  isCustomNodeModule,
  packageDirFromModule,
  parseWorkflowNodeTypes,
  synthesizeLedgerNodes,
  type ProvenanceMap
} from "./deployLedgerSynthesis";

describe("packageDirFromModule / isCustomNodeModule", () => {
  it("extracts the custom_nodes dir name", () => {
    expect(packageDirFromModule("custom_nodes.comfyui-workflow-encrypt")).toBe("comfyui-workflow-encrypt");
    expect(packageDirFromModule("custom_nodes.ComfyUI-VideoHelperSuite")).toBe("ComfyUI-VideoHelperSuite");
  });
  it("returns undefined for core / non-custom modules", () => {
    expect(packageDirFromModule("nodes")).toBeUndefined();
    expect(packageDirFromModule("comfy_extras.nodes_custom_sampler")).toBeUndefined();
    expect(packageDirFromModule(undefined)).toBeUndefined();
  });
  it("classifies custom vs core", () => {
    expect(isCustomNodeModule("custom_nodes.foo")).toBe(true);
    expect(isCustomNodeModule("nodes")).toBe(false);
    expect(isCustomNodeModule("comfy_extras.x")).toBe(false);
    expect(isCustomNodeModule(undefined)).toBe(false);
  });
});

describe("parseWorkflowNodeTypes", () => {
  it("maps class_type → python_module from an object_info summary", () => {
    const summary = {
      UNETLoader: { python_module: "nodes" },
      VHS_LoadVideo: { python_module: "custom_nodes.ComfyUI-VideoHelperSuite" },
      Weird: { category: "x" } // no python_module
    };
    const out = parseWorkflowNodeTypes(summary);
    expect(out).toContainEqual({ nodeType: "UNETLoader", pythonModule: "nodes" });
    expect(out).toContainEqual({ nodeType: "VHS_LoadVideo", pythonModule: "custom_nodes.ComfyUI-VideoHelperSuite" });
    expect(out).toContainEqual({ nodeType: "Weird", pythonModule: undefined });
  });
  it("is lenient about bad shapes", () => {
    expect(parseWorkflowNodeTypes(null)).toEqual([]);
    expect(parseWorkflowNodeTypes("nope")).toEqual([]);
  });
});

describe("synthesizeLedgerNodes — authoritative provenance only", () => {
  it("uses the static registry for known node families (no git needed)", () => {
    const { nodes } = synthesizeLedgerNodes([
      { nodeType: "llama_cpp_model_loader", pythonModule: "custom_nodes.ComfyUI-llama-cpp_vlm" },
      { nodeType: "llama_cpp_parameters", pythonModule: "custom_nodes.ComfyUI-llama-cpp_vlm" }
    ]);
    expect(nodes).toHaveLength(2);
    for (const n of nodes) {
      expect(n.repository).toBe("https://github.com/lihaoyun6/ComfyUI-llama-cpp_vlm");
      expect(n.packageName).toBe("ComfyUI-llama-cpp_vlm");
    }
  });

  it("falls back to harvested git provenance for registry-unknown custom nodes", () => {
    const prov: ProvenanceMap = {
      "comfyui-rh-bernini": { repository: "https://github.com/RH-RunningHub/ComfyUI-RH-Bernini", commit: "06f89ff5daa2" }
    };
    const { nodes, unattributed } = synthesizeLedgerNodes(
      [{ nodeType: "BerniniPromptEnhancer", pythonModule: "custom_nodes.comfyui-rh-bernini" }],
      prov
    );
    expect(nodes).toEqual([
      {
        nodeType: "BerniniPromptEnhancer",
        repository: "https://github.com/RH-RunningHub/ComfyUI-RH-Bernini",
        packageName: "comfyui-rh-bernini",
        commit: "06f89ff5daa2"
      }
    ]);
    expect(unattributed).toEqual([]);
  });

  it("skips (does NOT invent) custom nodes with no authoritative repo", () => {
    const { nodes, unattributed } = synthesizeLedgerNodes([
      { nodeType: "JjkText", pythonModule: "custom_nodes.comfyui-workflow-encrypt" }
    ]);
    expect(nodes).toEqual([]);
    expect(unattributed).toEqual(["JjkText"]);
  });

  it("ignores core / comfy_extras nodes entirely", () => {
    const { nodes, unattributed } = synthesizeLedgerNodes([
      { nodeType: "UNETLoader", pythonModule: "nodes" },
      { nodeType: "SamplerCustom", pythonModule: "comfy_extras.nodes_custom_sampler" }
    ]);
    expect(nodes).toEqual([]);
    expect(unattributed).toEqual([]);
  });

  it("dedups repeated class_types", () => {
    const { nodes } = synthesizeLedgerNodes([
      { nodeType: "llama_cpp_model_loader", pythonModule: "custom_nodes.ComfyUI-llama-cpp_vlm" },
      { nodeType: "llama_cpp_model_loader", pythonModule: "custom_nodes.ComfyUI-llama-cpp_vlm" }
    ]);
    expect(nodes).toHaveLength(1);
  });

  it("registry match wins even without git provenance and without a custom_nodes module hint", () => {
    const { nodes } = synthesizeLedgerNodes([{ nodeType: "llama_cpp_instruct_adv", pythonModule: "nodes" }]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].repository).toContain("ComfyUI-llama-cpp_vlm");
  });
});
