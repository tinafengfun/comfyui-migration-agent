import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskWorkspace, deleteTaskWorkspace, getLayoutForTask } from "./taskWorkspaces";

describe("task workspace layout", () => {
  it("creates a clean task workspace with fixed source, artifact, cache, output, log, and package paths", async () => {
    const workspaceRoot = path.join(process.cwd(), ".demo-state", "tests", `workspace-layout-${Date.now()}`);
    const layout = await createTaskWorkspace({
      workspaceRootPath: workspaceRoot,
      taskId: "task-clean",
      workflowFileName: "../unsafe workflow.json"
    });

    expect(layout.root).toBe(path.join(workspaceRoot, "task-clean"));
    expect(layout.workflowPath).toBe(path.join(layout.root, "source", "unsafe_workflow.json"));
    expect(layout.artifactPath).toBe(path.join(layout.root, "artifacts"));
    expect(layout.customNodeCacheDir).toBe(path.join(layout.root, "cache", "custom_nodes"));
    expect(layout.comfyUserDir).toBe(path.join(layout.root, "cache", "comfyui-user"));
    expect(layout.previewOutputDir).toBe(path.join(layout.root, "outputs", "previews"));
    expect(layout.validationRunsDir).toBe(path.join(layout.root, "outputs", "validation-runs"));
    expect(layout.guiAcceptanceDir).toBe(path.join(layout.root, "outputs", "gui-acceptance"));
    expect(layout.sdkLogPath).toBe(path.join(layout.root, "logs", "sdk-session.jsonl"));
    expect(layout.packageManifestPath).toBe(path.join(layout.root, "package", "manifest.json"));
    expect(layout.bundlePath).toBe(path.join(layout.root, "package", "migration-bundle.zip"));
    expect(layout.taskStatePath).toBe(path.join(layout.root, "task-state.json"));

    const manifest = JSON.parse(await fs.readFile(layout.packageManifestPath, "utf8")) as {
      manifestVersion: string;
      packagingPolicy: { includeLargeModels: boolean; modelStorageRoot: string };
      layout: { sourceWorkflow: string; bundle: string };
    };
    expect(manifest.manifestVersion).toBe("migration-workspace-v1");
    expect(manifest.layout.sourceWorkflow).toBe("source/unsafe_workflow.json");
    expect(manifest.layout.bundle).toBe("package/migration-bundle.zip");
    expect(manifest.packagingPolicy.includeLargeModels).toBe(false);
    expect(manifest.packagingPolicy.modelStorageRoot).toBe("/home/intel/hf_models");
  });

  it("reconstructs layout from a persisted task and refuses deletion outside the workspace root", async () => {
    const workspaceRoot = path.join(process.cwd(), ".demo-state", "tests", `workspace-delete-${Date.now()}`);
    const layout = await createTaskWorkspace({
      workspaceRootPath: workspaceRoot,
      taskId: "task-delete",
      workflowFileName: "workflow.json"
    });
    const reconstructed = getLayoutForTask({
      id: "task-delete",
      workspacePath: layout.root,
      workflowPath: layout.workflowPath,
      artifactPath: layout.artifactPath
    });

    expect(reconstructed.packageManifestPath).toBe(layout.packageManifestPath);
    await expect(deleteTaskWorkspace(workspaceRoot, path.dirname(workspaceRoot))).rejects.toThrow(/outside workspace root/);
    await deleteTaskWorkspace(workspaceRoot, layout.root);
    await expect(fs.stat(layout.root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
