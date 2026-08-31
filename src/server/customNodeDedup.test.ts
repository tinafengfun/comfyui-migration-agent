import { describe, expect, it } from "vitest";
import { planCaseDedup } from "./customNodeDedup";
import { nodeClassFromRoute } from "../catalog/schema";

describe("nodeClassFromRoute (taxonomy unification)", () => {
  it("maps migrationRoute → A/B/C, undefined for human/na", () => {
    expect(nodeClassFromRoute("unsupported_cuda_kernel")).toBe("A");
    expect(nodeClassFromRoute("auto_deps")).toBe("B");
    expect(nodeClassFromRoute("auto_device_redirect")).toBe("C");
    expect(nodeClassFromRoute("auto_fp8")).toBe("C");
    expect(nodeClassFromRoute("auto_attention_fallback")).toBe("C");
    expect(nodeClassFromRoute("auto_enum")).toBe("C");
    expect(nodeClassFromRoute("human_source_work")).toBeUndefined();
    expect(nodeClassFromRoute("not_applicable")).toBeUndefined();
    expect(nodeClassFromRoute(undefined)).toBeUndefined();
  });
});

describe("planCaseDedup", () => {
  it("keeps the lowercase variant and removes the CamelCase dup", () => {
    const plan = planCaseDedup([
      { name: "comfyui-advancedliveportrait" },
      { name: "ComfyUI-AdvancedLivePortrait" },
      { name: "rgthree-comfy" }
    ]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].keep).toBe("comfyui-advancedliveportrait");
    expect(plan.actions[0].remove).toEqual(["ComfyUI-AdvancedLivePortrait"]);
  });

  it("protects a catalog-referenced variant (keeps it, never removes it)", () => {
    const plan = planCaseDedup(
      [{ name: "comfyui-kjnodes" }, { name: "ComfyUI-KJNodes" }],
      ["/nfs_share/custom_nodes/ComfyUI-KJNodes"]
    );
    expect(plan.actions[0].keep).toBe("ComfyUI-KJNodes");
    expect(plan.actions[0].remove).toEqual(["comfyui-kjnodes"]);
    expect(plan.actions[0].reason).toContain("catalog");
  });

  it("prefers a real directory over a symlink", () => {
    const plan = planCaseDedup([
      { name: "Foo", isSymlink: true },
      { name: "foo", isSymlink: false }
    ]);
    expect(plan.actions[0].keep).toBe("foo");
    expect(plan.actions[0].remove).toEqual(["Foo"]);
  });

  it("marks ambiguous when two variants are both catalog-referenced", () => {
    const plan = planCaseDedup(
      [{ name: "Node" }, { name: "node" }],
      ["/nfs/custom_nodes/Node", "/nfs/custom_nodes/node"]
    );
    expect(plan.actions).toHaveLength(0);
    expect(plan.ambiguous).toHaveLength(1);
  });

  it("no action for a unique (non-duplicated) listing", () => {
    const plan = planCaseDedup([{ name: "a" }, { name: "b" }, { name: "c" }]);
    expect(plan.actions).toHaveLength(0);
    expect(plan.ambiguous).toHaveLength(0);
  });
});
