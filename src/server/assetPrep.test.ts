import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureAssetPrep } from "./assetPrep";
import { ensureDir } from "./fsUtils";

describe("asset prep", () => {
  it("writes deterministic Step 03 asset and custom-node ledgers", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-prep-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const workflowPath = path.join(root, "workflow.json");
    const modelRoot = path.join(root, "models");
    const comfyuiRoot = path.join(root, "ComfyUI");
    await ensureDir(artifactPath);
    await ensureDir(path.join(modelRoot, "checkpoints"));
    await ensureDir(path.join(comfyuiRoot, "custom_nodes", "ComfyUI-KJNodes"));
    await fs.writeFile(path.join(modelRoot, "checkpoints", "present.safetensors"), "x", "utf8");
    await ensureDir(path.join(modelRoot, "vae"));
    await fs.writeFile(path.join(modelRoot, "vae", "qwen_image_vae.safetensors"), "x", "utf8");
    await fs.writeFile(path.join(modelRoot, "checkpoints", "z_image_turbo_bf16.safetensors"), "x", "utf8");
    await fs.writeFile(path.join(modelRoot, "checkpoints", "wan_lightx2v_lora_rank128_bf16.safetensors"), "x", "utf8");
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        nodes: [
          {
            id: 1,
            type: "CheckpointLoaderSimple",
            properties: { cnr_id: "comfy-core" },
            widgets_values: ["present.safetensors"]
          },
          {
            id: 2,
            type: "KJNodesSomething",
            properties: { cnr_id: "comfyui-kjnodes" },
            widgets_values: ["missing.safetensors"]
          },
          {
            id: 3,
            type: "UNETLoader",
            properties: { cnr_id: "comfy-core" },
            widgets_values: ["z_image_bf16.safetensors"]
          },
          {
            id: 4,
            type: "VAELoader",
            properties: { cnr_id: "comfy-core" },
            widgets_values: ["Qwen\\qwen_image_vae.safetensors"]
          }
        ],
        links: []
      }),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task",
      name: "Task",
      status: "running",
      workflowPath,
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "03", status: "running" }]
    };

    const result = await ensureAssetPrep({ task, modelRoots: [modelRoot], comfyuiRoot });

    expect(result.modelCount).toBe(4);
    expect(result.customNodeCount).toBe(1);
    const csv = await fs.readFile(result.assetsPath, "utf8");
    const customNodes = await fs.readFile(result.customNodesPath, "utf8");
    expect(csv).toContain("present.safetensors");
    expect(csv).toContain("missing.safetensors");
    expect(csv).toContain("z_image_turbo_bf16.safetensors");
    expect(csv).toContain("Qwen\\qwen_image_vae.safetensors");
    expect(csv).toContain("local model root exact match");
    expect(csv).not.toContain("wan_lightx2v_lora_rank128_bf16.safetensors");
    expect(csv).toContain("source-identical asset not staged");
    expect(customNodes).toContain("orchestrator_status: complete");
    expect(customNodes).toContain("comfyui-kjnodes");
    expect(customNodes).toContain("custom_nodes/ComfyUI-KJNodes");
  });

  it("finds input media already in ComfyUI's input/ dir and custom-node-bundled checkpoints (e.g. RIFE)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-prep-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const workflowPath = path.join(root, "workflow.json");
    const comfyuiRoot = path.join(root, "ComfyUI");
    await ensureDir(artifactPath);
    await ensureDir(path.join(comfyuiRoot, "input"));
    await ensureDir(path.join(comfyuiRoot, "custom_nodes", "ComfyUI-Frame-Interpolation", "ckpts", "rife"));
    await fs.writeFile(path.join(comfyuiRoot, "input", "photo1.jpg"), "x", "utf8");
    await fs.writeFile(
      path.join(comfyuiRoot, "custom_nodes", "ComfyUI-Frame-Interpolation", "ckpts", "rife", "rife47.pth"),
      "x",
      "utf8"
    );
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        nodes: [
          { id: 1, type: "LoadImage", properties: { cnr_id: "comfy-core" }, widgets_values: ["photo1.jpg"] },
          { id: 2, type: "LoadImage", properties: { cnr_id: "comfy-core" }, widgets_values: ["nowhere.jpg"] },
          {
            id: 3,
            type: "RIFE VFI",
            properties: { cnr_id: "comfyui-frame-interpolation" },
            widgets_values: ["rife47.pth"]
          }
        ],
        links: []
      }),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task",
      name: "Task",
      status: "running",
      workflowPath,
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "01", status: "running" }]
    };

    const result = await ensureAssetPrep({ task, modelRoots: [], comfyuiRoot });
    const csv = await fs.readFile(result.assetsPath, "utf8");

    expect(csv).toContain("photo1.jpg");
    expect(csv).toContain("local ComfyUI input dir exact match");
    expect(csv).toContain("nowhere.jpg");
    expect(csv).toContain("input media file not staged");
    expect(csv).toContain("rife47.pth");
    expect(csv).toContain("local model root exact match");
    expect(result.gapDetails.some((g) => g.name === "photo1.jpg")).toBe(false);
    expect(result.gapDetails.some((g) => g.name === "nowhere.jpg")).toBe(true);
    expect(result.gapDetails.some((g) => g.name === "rife47.pth")).toBe(false);
  });

  it("rowsNeedingSearchCount includes weak local-alias matches that gapCount deliberately excludes", async () => {
    // Regression test for a real bug: orchestrator.ts previously gated its
    // first-pass provider search (see assetFuzzyMatch.ts) on gapCount > 0,
    // but gapCount excludes "alias available" rows -- so when local search
    // happened to find ANY weak alias for every unresolved item, provider
    // search never ran at all, even though a weak alias is exactly the
    // ambiguous case fuzzy/provider search can upgrade to a confident match.
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-prep-alias-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const workflowPath = path.join(root, "workflow.json");
    const modelRoot = path.join(root, "models");
    const comfyuiRoot = path.join(root, "ComfyUI");
    await ensureDir(artifactPath);
    await ensureDir(path.join(modelRoot, "checkpoints"));
    // No exact match for "z_image_bf16.safetensors" -- only a similarly
    // named file, which findAliases() will surface as a weak alias.
    await fs.writeFile(path.join(modelRoot, "checkpoints", "z_image_turbo_bf16.safetensors"), "x", "utf8");
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        nodes: [
          {
            id: 1,
            type: "UNETLoader",
            properties: { cnr_id: "comfy-core" },
            widgets_values: ["z_image_bf16.safetensors"]
          }
        ],
        links: []
      }),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task",
      name: "Task",
      status: "running",
      workflowPath,
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "01", status: "running" }]
    };

    const result = await ensureAssetPrep({ task, modelRoots: [modelRoot], comfyuiRoot });

    expect(result.gapCount).toBe(0);
    expect(result.rowsNeedingSearchCount).toBe(1);
  });
});
