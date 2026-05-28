import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureDir } from "./fsUtils";
import { ensureSourceAuditCheckpoint } from "./sourceAuditCheckpoint";

describe("source audit checkpoint", () => {
  it("creates a scoped Step 04 artifact before deep analysis", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `source-audit-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const comfyuiRoot = path.join(root, "ComfyUI");
    await ensureDir(artifactPath);
    await ensureDir(path.join(comfyuiRoot, "custom_nodes", "ComfyUI-QwenVL"));
    await fs.writeFile(
      path.join(comfyuiRoot, "custom_nodes", "ComfyUI-QwenVL", "AILab_QwenVL.py"),
      "device = 'cuda' if torch.cuda.is_available() else 'cpu'\n",
      "utf8"
    );
    await ensureDir(
      path.join(
        comfyuiRoot,
        "custom_nodes",
        "ComfyUI-SeedVR2_VideoUpscaler",
        "src",
        "interfaces"
      )
    );
    await fs.writeFile(
      path.join(
        comfyuiRoot,
        "custom_nodes",
        "ComfyUI-SeedVR2_VideoUpscaler",
        "src",
        "interfaces",
        "dit_model_loader.py"
      ),
      "devices = get_device_list()\n",
      "utf8"
    );
    await fs.writeFile(path.join(artifactPath, "02-inventory.md"), "# inventory\n", "utf8");
    await fs.writeFile(path.join(artifactPath, "03-custom-nodes.md"), "# custom nodes\n", "utf8");
    const task: MigrationTask = {
      id: "task-1",
      name: "Task",
      status: "pending",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "04", status: "pending" }]
    };

    const result = await ensureSourceAuditCheckpoint({ task, comfyuiRoot });

    expect(result.created).toBe(true);
    const content = await fs.readFile(result.path, "utf8");
    expect(content).toContain("SeedVR2 loader device widgets");
    expect(content).toContain("AILab_QwenVL.py:1");
    expect(content).toContain("Selected SeedVR2 source hits");
    expect(content).toContain("dit_model_loader.py:1");
  });
});
