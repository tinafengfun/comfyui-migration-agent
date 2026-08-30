import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyRequirement,
  parseRequirementName,
  normalizePackage,
  nodeClassFor,
  parseWheelFilename,
  readWheelhouseIndex,
  wheelForPackage,
  upsertWheelhouseEntry,
  writeWheelhouseIndex,
  planWheelInstall,
  missingClassAWheels,
  classAHardStopMessage,
  type WheelhouseIndex
} from "./wheelhouse";

describe("Node-Class taxonomy", () => {
  it("classifies requirements into image / classA / normal", () => {
    expect(classifyRequirement("torch==2.11.0")).toBe("image");
    expect(classifyRequirement("torchvision")).toBe("image");
    expect(classifyRequirement("nvidia-cublas-cu12")).toBe("image");
    expect(classifyRequirement("triton==2.0")).toBe("image");
    expect(classifyRequirement("flash-attn>=2.5")).toBe("classA");
    expect(classifyRequirement("flash_attn")).toBe("classA");
    expect(classifyRequirement("xformers")).toBe("classA");
    expect(classifyRequirement("sageattention")).toBe("classA");
    expect(classifyRequirement("onnxruntime-gpu")).toBe("classA");
    expect(classifyRequirement("numpy>=1.24")).toBe("normal");
    expect(classifyRequirement("# a comment")).toBe("normal");
  });

  it("nodeClassFor picks A if any classA, else B if any pip, else C", () => {
    expect(nodeClassFor(["numpy", "flash-attn"])).toBe("A");
    expect(nodeClassFor(["numpy", "requests"])).toBe("B");
    expect(nodeClassFor(["torch"])).toBe("C"); // only image-provided → no build, no pip
    expect(nodeClassFor([])).toBe("C");
  });

  it("parseRequirementName + normalizePackage", () => {
    expect(parseRequirementName("flash-attn==2.5.0  # xpu")).toBe("flash-attn");
    expect(normalizePackage("Flash_Attn")).toBe("flash-attn");
    expect(normalizePackage("onnxruntime.gpu")).toBe("onnxruntime-gpu");
  });
});

describe("wheelhouse index", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wheelhouse-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("parseWheelFilename extracts normalized name + version", () => {
    expect(parseWheelFilename("flash_attn-2.5.0-cp311-cp311-linux_x86_64.whl")).toEqual({
      package: "flash-attn",
      version: "2.5.0"
    });
    expect(parseWheelFilename("not-a-wheel.txt")).toBeUndefined();
  });

  it("scans *.whl when no manifest exists", async () => {
    await fsp.writeFile(path.join(dir, "sageattention-1.0.6-cp311-linux.whl"), "");
    const index = await readWheelhouseIndex(dir);
    expect(wheelForPackage(index, "sageattention")?.file).toBe("sageattention-1.0.6-cp311-linux.whl");
    expect(wheelForPackage(index, "flash-attn")).toBeUndefined();
  });

  it("prefers the manifest and round-trips upsert/write/read", async () => {
    let index: WheelhouseIndex = { entries: [] };
    index = upsertWheelhouseEntry(index, { package: "Flash_Attn", file: "flash_attn-2.5-x.whl", version: "2.5", builtFor: "xpu-sycl" });
    index = upsertWheelhouseEntry(index, { package: "flash-attn", file: "flash_attn-2.6-x.whl", version: "2.6" }); // replace
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].file).toBe("flash_attn-2.6-x.whl");
    await writeWheelhouseIndex(dir, index);
    const read = await readWheelhouseIndex(dir);
    expect(wheelForPackage(read, "flash-attn")?.version).toBe("2.6");
  });
});

describe("planWheelInstall + Class-A enforcement", () => {
  const index: WheelhouseIndex = { entries: [{ package: "sageattention", file: "sageattention-1.0-x.whl" }] };

  it("skips image-provided, installs normal, splits Class-A by wheel availability", () => {
    const plan = planWheelInstall(
      ["torch==2.11.0", "numpy", "sageattention", "flash-attn", "# comment", ""],
      index
    );
    expect(plan.skipped).toContain("torch==2.11.0");
    expect(plan.install).toEqual(["numpy"]);
    expect(plan.classAResolved).toEqual(["sageattention"]); // has a wheel
    expect(plan.classAMissing).toEqual(["flash-attn"]); // no wheel → route to Builder
  });

  it("classAHardStopMessage names the missing wheels + the Builder", () => {
    const msg = classAHardStopMessage(["flash-attn"]);
    expect(msg).toContain("flash-attn");
    expect(msg).toContain("build-wheel.mts");
    expect(msg).toContain("never compiles Class-A");
  });
});

describe("missingClassAWheels", () => {
  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "customnodes-"));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("collects uncached Class-A deps across the profile's requirements.txt files", async () => {
    await fsp.mkdir(path.join(root, "NodeA"), { recursive: true });
    await fsp.writeFile(path.join(root, "NodeA", "requirements.txt"), "numpy\nflash-attn>=2.5\n");
    await fsp.mkdir(path.join(root, "NodeB"), { recursive: true });
    await fsp.writeFile(path.join(root, "NodeB", "requirements.txt"), "torch\nsageattention\n");
    // NodeC has no requirements.txt — contributes nothing
    await fsp.mkdir(path.join(root, "NodeC"), { recursive: true });

    // wheelhouse has sageattention but NOT flash-attn
    const wh = await fsp.mkdtemp(path.join(os.tmpdir(), "wh-"));
    await fsp.writeFile(path.join(wh, "sageattention-1.0-x.whl"), "");

    const missing = await missingClassAWheels({
      packages: ["NodeA", "NodeB", "NodeC"],
      customNodesRoot: root,
      wheelhouseDir: wh
    });
    expect(missing).toEqual(["flash-attn"]);
    await fsp.rm(wh, { recursive: true, force: true });
  });
});
