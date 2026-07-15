import { describe, expect, it } from "vitest";
import {
  detectEnumDependencies,
  enumSlotsForNode,
  renderEnumDependencyCsv,
  COMFY_CORE_ENUM_BASELINE,
  type ObjectInfo
} from "./enumDependencies";

// Source object_info: KSampler whose sampler_name dropdown was EXTENDED by a
// package to include res_2s, and scheduler to include bong_tangent.
const SOURCE_INFO: ObjectInfo = {
  KSampler: {
    input: {
      required: {
        sampler_name: [["euler", "res_multistep", "res_2s"], {}],
        scheduler: [["normal", "karras", "bong_tangent"], {}],
        steps: ["INT", { default: 20 }]
      }
    }
  }
};

// widget_values order for KSampler: [seed, control, steps, cfg, sampler_name, scheduler, denoise]
const cyclicKSamplerNode = {
  id: 22,
  type: "KSampler",
  widgets_values: [480631362443636, "randomize", 8, 1, "res_2s", "bong_tangent", 1]
};

describe("enumDependencies", () => {
  it("enumSlotsForNode extracts list-type slots only", () => {
    const slots = enumSlotsForNode(SOURCE_INFO, "KSampler");
    expect(Object.keys(slots).sort()).toEqual(["sampler_name", "scheduler"]);
    expect(slots.sampler_name).toContain("res_2s");
    expect(slots).not.toHaveProperty("steps"); // INT is not an enum
  });

  it("flags res_2s + bong_tangent as implicit package deps (source has, target-core lacks)", () => {
    const resolve = (slot: string, value: string) =>
      value === "res_2s" || value === "bong_tangent" ? "https://github.com/ClownsharkBatwing/RES4LYF" : undefined;
    const deps = detectEnumDependencies([cyclicKSamplerNode], SOURCE_INFO, resolve);
    expect(deps).toHaveLength(2);
    const bySlot = Object.fromEntries(deps.map((d) => [d.slot, d]));
    expect(bySlot.sampler_name.value).toBe("res_2s");
    expect(bySlot.sampler_name.sourceHas).toBe(true);
    expect(bySlot.sampler_name.targetCoreHas).toBe(false);
    expect(bySlot.sampler_name.resolvingPackage).toContain("RES4LYF");
    expect(bySlot.sampler_name.state).toBe("source known");
    expect(bySlot.scheduler.value).toBe("bong_tangent");
  });

  it("does NOT flag a core value that the target already provides", () => {
    const coreNode = {
      id: 5,
      type: "KSampler",
      widgets_values: [1, "randomize", 20, 8, "euler", "normal", 1]
    };
    const deps = detectEnumDependencies([coreNode], SOURCE_INFO, () => undefined);
    expect(deps).toHaveLength(0); // euler + normal are in COMFY_CORE_ENUM_BASELINE
  });

  it("flags unidentified package deps as 'source unknown' (no resolver hit)", () => {
    const deps = detectEnumDependencies([cyclicKSamplerNode], SOURCE_INFO, () => undefined);
    expect(deps).toHaveLength(2);
    expect(deps.every((d) => d.state === "source unknown")).toBe(true);
    expect(deps[0].resolvingPackage).toMatch(/identify from source/);
  });

  it("works without source object_info via baseline + resolver (source unreachable path)", () => {
    const resolve = (_slot: string, value: string) =>
      value === "res_2s" ? "RES4LYF" : undefined;
    const deps = detectEnumDependencies([cyclicKSamplerNode], undefined, resolve);
    // res_2s classified via resolver into sampler_name slot; bong_tangent has no
    // resolver + not core → not classifiable without source info.
    expect(deps.some((d) => d.value === "res_2s" && d.slot === "sampler_name")).toBe(true);
  });

  it("ignores model/media filenames (not enum values)", () => {
    const node = {
      id: 1,
      type: "CheckpointLoaderSimple",
      widgets_values: ["model.safetensors", "image.png"]
    };
    const deps = detectEnumDependencies([node], SOURCE_INFO, () => "x");
    expect(deps).toHaveLength(0);
  });

  it("baseline sanity: res_multistep is core, res_2s is not", () => {
    expect(COMFY_CORE_ENUM_BASELINE.sampler_name.has("res_multistep")).toBe(true);
    expect(COMFY_CORE_ENUM_BASELINE.sampler_name.has("res_2s")).toBe(false);
    expect(COMFY_CORE_ENUM_BASELINE.scheduler.has("normal")).toBe(true);
    expect(COMFY_CORE_ENUM_BASELINE.scheduler.has("bong_tangent")).toBe(false);
  });

  it("renders CSV with header + rows", () => {
    const deps = detectEnumDependencies([cyclicKSamplerNode], SOURCE_INFO, () => "RES4LYF");
    const csv = renderEnumDependencyCsv(deps);
    expect(csv.split("\n")[0]).toBe(
      "node_id,node_type,widget_slot,value,source_has,target_core_has,resolving_package,state"
    );
    expect(csv).toContain("res_2s");
    expect(csv).toContain("bong_tangent");
  });
});
